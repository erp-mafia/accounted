
-- Read-only, tenant-scoped source comparison. Posted content remains immutable.
CREATE FUNCTION public.classify_sie_resync_entries(p_company_id uuid,p_period_id uuid,p_entries jsonb)
RETURNS TABLE(source_ordinal integer,outcome text,entry_id uuid)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE e jsonb; ids uuid[]; original public.journal_entries; matches integer;
BEGIN
  IF jsonb_typeof(p_entries)<>'array' OR jsonb_array_length(p_entries)>200
    OR octet_length(p_entries::text)>2000000 THEN RAISE EXCEPTION 'SIE comparison too large'; END IF;
  IF NOT EXISTS(SELECT 1 FROM fiscal_periods WHERE id=p_period_id AND company_id=p_company_id) THEN
    RAISE EXCEPTION 'SIE comparison period unavailable' USING ERRCODE='42501'; END IF;
  FOR e IN SELECT value FROM jsonb_array_elements(p_entries) LOOP
    source_ordinal:=(e->>'sourceOrdinal')::integer; entry_id:=NULL;
    IF NULLIF(e->>'sourceSeries','') IS NULL OR e->>'sourceNumber' IS NULL THEN
      outcome:='unidentified'; RETURN NEXT; CONTINUE; END IF;
    SELECT array_agg(j.id) INTO ids FROM journal_entries j WHERE j.company_id=p_company_id AND j.fiscal_period_id=p_period_id
      AND j.source_type IN ('import','opening_balance') AND j.status='posted' AND j.reversed_by_id IS NULL
      AND j.source_voucher_series=e->>'sourceSeries' AND j.source_voucher_number=(e->>'sourceNumber')::integer;
    matches:=COALESCE(cardinality(ids),0);
    IF matches>1 THEN outcome:='ambiguous'; RETURN NEXT; CONTINUE; END IF;
    IF matches=0 THEN
      SELECT j.id INTO entry_id FROM journal_entries j WHERE j.company_id=p_company_id AND j.fiscal_period_id=p_period_id
        AND j.source_type IN ('import','opening_balance') AND j.source_voucher_series=e->>'sourceSeries'
        AND j.source_voucher_number=(e->>'sourceNumber')::integer ORDER BY j.created_at DESC,j.id LIMIT 1;
      outcome:=CASE WHEN entry_id IS NULL THEN 'new' ELSE 'changed' END; RETURN NEXT; CONTINUE;
    END IF;
    SELECT * INTO original FROM journal_entries WHERE id=ids[1] AND company_id=p_company_id;
    entry_id:=original.id;
    outcome:=CASE WHEN original.source_content_hash=encode(extensions.digest((e-'sieImportId'-'sourceOrdinal')::text,'sha256'),'hex')
      THEN 'unchanged' ELSE 'changed' END;
    RETURN NEXT;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.classify_sie_resync_entries(uuid,uuid,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.classify_sie_resync_entries(uuid,uuid,jsonb) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.start_sie_import_job(p_company_id uuid, p_actor uuid,
  p_period_id uuid, p_filename text, p_file_hash text, p_manifest jsonb,
  p_supersedes_import_id uuid DEFAULT NULL) RETURNS public.sie_imports
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports; v_period public.fiscal_periods; incremental boolean;
BEGIN
  PERFORM public.authorize_sie_execution(p_company_id, p_actor);
  IF p_file_hash !~ '^[0-9a-f]{64}$' OR p_file_hash IS NULL OR
     jsonb_typeof(p_manifest) IS DISTINCT FROM 'object' OR
     octet_length(p_manifest::text) > 1000000 THEN
    RAISE EXCEPTION 'Invalid SIE import manifest' USING ERRCODE = '22023';
  END IF;
  incremental:=p_manifest #>> '{input,options,onExistingPeriod}'='incremental';
  IF incremental AND (p_supersedes_import_id IS NOT NULL
    OR (p_manifest #>> '{input,options,importOpeningBalances}')::boolean IS DISTINCT FROM false
    OR (p_manifest #>> '{input,options,importTransactions}')::boolean IS DISTINCT FROM true) THEN
    RAISE EXCEPTION 'Invalid incremental SIE options' USING ERRCODE='22023';
  END IF;
  -- Enqueue accepts source inputs only. Checkpoints are worker-owned state.
  p_manifest := jsonb_build_object('input',p_manifest->'input',
    'file_storage_path',p_manifest->'file_storage_path',
    'originalSource',p_manifest->'originalSource');
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || p_company_id::text, 0));
  SELECT * INTO v_period FROM public.fiscal_periods WHERE id = p_period_id
    AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Fiscal period not found' USING ERRCODE = 'P0002'; END IF;
  IF (p_manifest #>> '{input,fiscalYear,start}') IS NULL OR
     (p_manifest #>> '{input,fiscalYear,end}') IS NULL OR
     (p_manifest #>> '{input,fiscalYear,start}')::date < v_period.period_start OR
     (p_manifest #>> '{input,fiscalYear,end}')::date > v_period.period_end OR
     (p_manifest #>> '{input,fiscalYear,start}')::date > (p_manifest #>> '{input,fiscalYear,end}')::date THEN
    RAISE EXCEPTION 'SIE source fiscal year does not fit the target period' USING ERRCODE = '22023';
  END IF;
  IF v_period.is_closed OR v_period.locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Fiscal period is locked or closed' USING ERRCODE = '55000';
  END IF;
  SELECT * INTO v_job FROM public.sie_imports WHERE company_id = p_company_id
    AND fiscal_period_id = p_period_id AND file_hash = p_file_hash
    AND job_state IS NOT NULL AND job_state NOT IN ('undone','failed')
    AND id IS DISTINCT FROM p_supersedes_import_id
    ORDER BY created_at DESC LIMIT 1;
  IF FOUND THEN
    IF v_job.manifest->'input' IS DISTINCT FROM p_manifest->'input' THEN
      RAISE EXCEPTION 'SIE retry has different mapping or options' USING ERRCODE = '23505';
    END IF;
    RETURN v_job;
  END IF;
  IF EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id = p_company_id
      AND job_state NOT IN ('completed','undone','failed') AND id IS DISTINCT FROM p_supersedes_import_id)
      OR (v_period.import_hold IS NOT NULL AND v_period.import_hold IS DISTINCT FROM p_supersedes_import_id) THEN
    RAISE EXCEPTION 'SIE import is unfinished: resume or undo it' USING ERRCODE = '55000';
  END IF;
  IF NOT COALESCE(incremental,false) AND (EXISTS (SELECT 1 FROM public.journal_entries WHERE company_id = p_company_id
      AND fiscal_period_id = p_period_id AND source_type IN ('import','opening_balance') AND status = 'posted'
      AND (p_supersedes_import_id IS NULL OR import_batch_id IS DISTINCT FROM p_supersedes_import_id)) OR
     EXISTS (SELECT 1 FROM public.sie_imports WHERE company_id = p_company_id
      AND fiscal_year_start <= v_period.period_end AND fiscal_year_end >= v_period.period_start
      AND id IS DISTINCT FROM p_supersedes_import_id
      AND (status = 'completed' OR (job_state IS NULL AND status IN ('pending','mapped'))))) THEN
    RAISE EXCEPTION 'Existing SIE import requires reviewed replacement or reconciliation' USING ERRCODE = '55000';
  END IF;
  IF p_supersedes_import_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.sie_imports
      WHERE id = p_supersedes_import_id AND company_id = p_company_id
      AND fiscal_period_id = p_period_id AND job_state IN ('undone','undoing')) THEN
    RAISE EXCEPTION 'SIE predecessor has not been completely undone' USING ERRCODE = '55000';
  END IF;
  INSERT INTO public.sie_imports(company_id, user_id, filename, file_hash, sie_type,
    fiscal_period_id, fiscal_year_start, fiscal_year_end, status, job_state, job_phase,
    manifest, supersedes_import_id, file_storage_path, execution_actor_id)
  VALUES (p_company_id, p_actor, p_filename, p_file_hash, 4, p_period_id,
    v_period.period_start, v_period.period_end, 'pending', 'queued', 'prepare',
    p_manifest || jsonb_build_object('prior_activity', EXISTS (
      SELECT 1 FROM public.journal_entries WHERE company_id = p_company_id
        AND source_type NOT IN ('opening_balance','storno') AND status = 'posted'
        AND (p_supersedes_import_id IS NULL OR import_batch_id IS DISTINCT FROM p_supersedes_import_id)
        AND entry_date <= v_period.period_end)),
    p_supersedes_import_id, p_manifest->>'file_storage_path', p_actor) RETURNING * INTO v_job;
  -- During replacement the predecessor keeps the hold until its last undo
  -- checkpoint. The successor cannot be claimed before that handoff.
  UPDATE public.fiscal_periods SET import_hold = v_job.id WHERE id = p_period_id AND import_hold IS NULL;
  RETURN v_job;
END;
$$;

NOTIFY pgrst,'reload schema';

-- Semantic hashes are initialized by the worker from retained encrypted snapshots.
-- Keep payload_hash as the original plaintext integrity/evidence hash.
ALTER TABLE public.migration_source_records ADD COLUMN source_hash text;
ALTER TABLE public.migration_job_chunks ADD COLUMN source_hash text;
CREATE INDEX migration_source_snapshot_lookup ON public.migration_job_chunks(company_id,resource,source_id,updated_at DESC)
  WHERE state='done';
CREATE FUNCTION public.read_provider_source_hash_baselines(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_resource text,p_ids text[])
RETURNS TABLE(record_id uuid,chunk_id uuid,payload_hash text,payload text)
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'discover' OR j.resources[j.resource_index]<>p_resource OR cardinality(p_ids)>1000 THEN
    RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  RETURN QUERY SELECT m.id,source.id,source.payload_hash,source.payload FROM migration_source_records m
    CROSS JOIN LATERAL(SELECT c.id,c.payload_hash,c.payload FROM migration_job_chunks c JOIN migration_jobs old ON old.id=c.job_id
      WHERE c.company_id=j.company_id AND c.resource=m.resource AND c.source_id=m.source_id AND c.target_id=m.target_id
        AND old.provider=j.provider AND old.account_key=j.account_key AND old.state='completed' AND c.state='done'
      ORDER BY c.updated_at DESC,c.id DESC LIMIT 1) source
    WHERE m.company_id=j.company_id AND m.provider=j.provider AND m.account_key=j.account_key
      AND m.resource=p_resource AND m.source_id=ANY(p_ids) AND m.source_hash IS NULL;
END $$;
REVOKE ALL ON FUNCTION public.read_provider_source_hash_baselines(uuid,uuid,integer,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.read_provider_source_hash_baselines(uuid,uuid,integer,text,text[]) TO service_role;

CREATE FUNCTION public.initialize_provider_source_hashes(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_rows jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; r jsonb;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'discover' OR jsonb_array_length(p_rows)>1000 THEN RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_rows) LOOP
    IF COALESCE(r->>'source_hash','') !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'MIGRATION_SOURCE_HASH_INVALID'; END IF;
    UPDATE migration_source_records m SET source_hash=r->>'source_hash'
      FROM migration_job_chunks c JOIN migration_jobs old ON old.id=c.job_id
      WHERE m.id=(r->>'record_id')::uuid AND c.id=(r->>'chunk_id')::uuid AND m.source_hash IS NULL
        AND m.company_id=j.company_id AND c.company_id=j.company_id AND m.provider=j.provider AND m.account_key=j.account_key
        AND c.resource=m.resource AND c.source_id=m.source_id AND c.target_id=m.target_id
        AND old.provider=j.provider AND old.account_key=j.account_key AND old.state='completed' AND c.state='done'
        AND c.payload_hash=r->>'payload_hash';
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.initialize_provider_source_hashes(uuid,uuid,integer,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_provider_source_hashes(uuid,uuid,integer,jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.save_provider_migration_page(p_job_id uuid,p_worker_id uuid,p_attempt integer,
  p_resource text,p_page integer,p_records jsonb,p_next_page integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; r jsonb; prior public.migration_source_records; target_exists boolean; tbl text;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'discover' OR j.resources[j.resource_index]<>p_resource OR j.next_page<>p_page THEN
    RAISE EXCEPTION 'MIGRATION_CURSOR_CONFLICT';
  END IF;
  IF jsonb_array_length(p_records)>1000 THEN RAISE EXCEPTION 'MIGRATION_PAGE_TOO_LARGE'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO prior FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
      AND account_key=j.account_key AND resource=p_resource AND source_id=r->>'source_id';
    target_exists:=false;
    IF prior.target_id IS NOT NULL THEN
      tbl:=CASE p_resource WHEN 'salesInvoices' THEN 'invoices' WHEN 'supplierInvoices' THEN 'supplier_invoices' ELSE p_resource END;
      EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE id=$1 AND company_id=$2)',tbl)
        INTO target_exists USING prior.target_id,j.company_id;
    END IF;
    INSERT INTO migration_job_chunks(job_id,company_id,resource,source_id,resource_order,payload,payload_hash,source_hash,state,target_id,receipt,error_code,error_phase)
    VALUES(j.id,j.company_id,p_resource,r->>'source_id',j.resource_index,r->>'payload',r->>'payload_hash',r->>'source_hash',
      CASE WHEN r ? 'skip' THEN 'skipped' WHEN target_exists AND prior.source_hash=r->>'source_hash' THEN 'skipped'
        WHEN target_exists AND prior.source_hash IS NOT NULL THEN 'needs_attention' ELSE 'pending' END,
      CASE WHEN r ? 'skip' THEN NULL WHEN target_exists THEN prior.target_id END,
      CASE WHEN r ? 'skip' THEN jsonb_build_object('reason',r->>'skip')
        WHEN target_exists AND prior.source_hash=r->>'source_hash' THEN '{"reason":"unchanged"}'::jsonb
        WHEN target_exists AND prior.source_hash IS NOT NULL THEN '{"reason":"source_changed"}'::jsonb ELSE '{}'::jsonb END,
      CASE WHEN NOT(r ? 'skip') AND target_exists AND prior.source_hash IS NOT NULL AND prior.source_hash IS DISTINCT FROM r->>'source_hash'
        THEN 'MIGRATION_SOURCE_CHANGED' END,
      CASE WHEN NOT(r ? 'skip') AND target_exists AND prior.source_hash IS NOT NULL AND prior.source_hash IS DISTINCT FROM r->>'source_hash' THEN 'import' END)
    ON CONFLICT(job_id,resource,source_id) DO NOTHING;
  END LOOP;
  IF p_next_page IS NULL THEN
    UPDATE migration_jobs SET resource_index=resource_index+1,next_page=1,
      phase=CASE WHEN resource_index=cardinality(resources) THEN 'import' ELSE 'discover' END,
      failures=0,error_code=NULL WHERE id=j.id;
  ELSIF p_next_page=0 THEN
    NULL; -- A persisted segment of an upstream page; its cursor stays put.
  ELSIF p_next_page=p_page+1 THEN
    UPDATE migration_jobs SET next_page=p_next_page,failures=0,error_code=NULL WHERE id=j.id;
  ELSE RAISE EXCEPTION 'MIGRATION_CURSOR_CONFLICT'; END IF;
END $$;

CREATE OR REPLACE FUNCTION public.commit_provider_migration_records(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; row_data jsonb; item jsonb;
  target uuid; party uuid; tbl text; ids uuid[]; row_result jsonb; was_new boolean; message text;
  legacy public.invoices;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'import' OR jsonb_array_length(p_records)>25 THEN RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=(r->>'id')::uuid AND job_id=j.id FOR UPDATE;
    IF c.state<>'pending' THEN CONTINUE; END IF;
    BEGIN
      IF r ? 'skip' THEN
        UPDATE migration_job_chunks SET state='skipped',receipt=jsonb_build_object('reason',r->>'skip') WHERE id=c.id;
        CONTINUE;
      END IF;
      IF r ? 'error' THEN RAISE EXCEPTION '%',r->>'error'; END IF;
      IF c.source_hash IS NULL AND r->>'source_hash' IS NOT NULL THEN
        IF r->>'source_hash' !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'MIGRATION_SOURCE_HASH_INVALID'; END IF;
        c.source_hash:=r->>'source_hash';
        UPDATE migration_job_chunks SET source_hash=c.source_hash WHERE id=c.id;
      END IF;
      IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id
        AND source_hash IS NOT NULL AND source_hash IS DISTINCT FROM c.source_hash) THEN
        RAISE EXCEPTION 'MIGRATION_SOURCE_CHANGED'; END IF;
      IF c.resource IN ('customers','suppliers') THEN
        target:=resolve_provider_migration_party(j.id,c.resource,c.source_id,r->'row');
        UPDATE migration_source_records SET source_hash=c.source_hash WHERE company_id=j.company_id AND provider=j.provider
          AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
        UPDATE migration_job_chunks SET state='done',target_id=target,receipt='{"imported":true}' WHERE id=c.id;
        CONTINUE;
      END IF;
      tbl:=CASE c.resource WHEN 'salesInvoices' THEN 'invoices' ELSE 'supplier_invoices' END;
      SELECT target_id INTO target FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
      was_new:=false;
      party:=NULL;
      -- A sales invoice number is unique per company: it is the record's own
      -- identity. Adopt on it, never on the customer the job derived for it.
      IF target IS NULL AND c.resource='salesInvoices' AND NULLIF(r->'row'->>'invoice_number','') IS NOT NULL THEN
        SELECT * INTO legacy FROM invoices WHERE company_id=j.company_id AND invoice_number=r->'row'->>'invoice_number'
          FOR UPDATE;
        IF FOUND THEN
          IF legacy.invoice_date IS DISTINCT FROM (r->'row'->>'invoice_date')::date
            OR legacy.currency IS DISTINCT FROM r->'row'->>'currency'
            OR legacy.total IS DISTINCT FROM (r->'row'->>'total')::numeric THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_NUMBER_TAKEN';
          END IF;
          IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
            AND account_key=j.account_key AND resource=c.resource AND target_id=legacy.id AND source_id<>c.source_id) THEN
            RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          IF legacy.customer_id IS NOT NULL THEN
            party:=adopt_provider_migration_invoice_party(j.id,r->>'party_source_id',legacy.customer_id);
          END IF;
          target:=legacy.id;
          INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
            VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
        END IF;
      END IF;
      IF party IS NULL THEN
        party:=resolve_provider_migration_party(j.id,
          CASE c.resource WHEN 'salesInvoices' THEN 'customers' ELSE 'suppliers' END,r->>'party_source_id',r->'party');
      END IF;
      row_data:=r->'row'||jsonb_build_object('company_id',j.company_id,'user_id',j.user_id,
        CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,party);
      IF target IS NULL THEN
        -- Supplier numbers are references, not unique identities. Adopt an older
        -- document only on supplier AND number AND date/currency/total/kind.
        -- Source mappings remain the durable identity; ambiguous matches stop.
        -- Number-less records are identified exclusively by their source map.
        EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I WHERE company_id=$1
          AND COALESCE($2->>''supplier_invoice_number'','''')<>''-''
          AND %I=$2->>%L AND %I=($2->>%L)::uuid AND invoice_date=($2->>''invoice_date'')::date
          AND currency=$2->>''currency'' AND total=($2->>''total'')::numeric %s LIMIT 2) matches',
          tbl,CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,
          CASE WHEN c.resource='supplierInvoices' THEN 'AND is_credit_note=COALESCE(($2->>''is_credit_note'')::boolean,false)' ELSE '' END)
          INTO ids USING j.company_id,row_data;
        IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        target:=ids[1];
        IF target IS NOT NULL AND EXISTS(SELECT 1 FROM migration_source_records
          WHERE company_id=j.company_id AND provider=j.provider AND account_key=j.account_key
            AND resource=c.resource AND target_id=target AND source_id<>c.source_id) THEN
          RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        IF target IS NULL THEN
          IF c.resource='supplierInvoices' THEN
            row_data:=row_data||jsonb_build_object('arrival_number',get_next_arrival_number(j.company_id));
          END IF;
          target:=insert_provider_migration_row(tbl,row_data);
          was_new:=true;
        END IF;
        INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
          VALUES(j.company_id,j.user_id,j.provider,j.account_key,c.resource,c.source_id,target);
      END IF;
      -- Never fill a native/adopted document with rows for a different amount.
      EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE id=$1 AND company_id=$2
        AND total=($3->>''total'')::numeric AND currency=$3->>''currency''',tbl) INTO ids USING target,j.company_id,row_data;
      IF ids IS NULL THEN RAISE EXCEPTION 'MIGRATION_INVOICE_CHANGED'; END IF;
      IF jsonb_array_length(r->'items')>0 THEN
        IF c.resource='salesInvoices' THEN
          row_result:=complete_invoice_rows(j.company_id,target,r->'items',
            CASE WHEN COALESCE((r->'warnings'->>'vatUnresolved')::boolean,false) THEN NULL ELSE
              jsonb_build_object('subtotal',row_data->'subtotal','subtotal_sek',row_data->'subtotal_sek',
                'vat_amount',row_data->'vat_amount','vat_amount_sek',row_data->'vat_amount_sek',
                'vat_rate',row_data->'vat_rate','vat_treatment',row_data->'vat_treatment') END);
          IF NOT COALESCE((row_result->>'ok')::boolean,false) THEN RAISE EXCEPTION '%',row_result->>'code'; END IF;
          IF (row_result->>'wrote')::boolean THEN
            INSERT INTO processing_history(company_id,correlation_id,aggregate_type,aggregate_id,event_type,payload,actor,occurred_at)
            VALUES(j.company_id,j.id,'Invoice',target,'InvoiceRowsCompleted',
              jsonb_build_object('source','provider-migration-worker','provider',j.provider,'consent_id',j.consent_id,
                'rows',jsonb_array_length(r->'items'),'header_updated',row_result->'header_updated'),
              jsonb_build_object('type','user','id',j.user_id),clock_timestamp());
          END IF;
        ELSE
          PERFORM 1 FROM supplier_invoices WHERE id=target AND company_id=j.company_id FOR UPDATE;
          IF NOT EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=target) THEN
            IF was_new AND NOT COALESCE((r->'warnings'->>'vatUnresolved')::boolean,false) THEN
              UPDATE supplier_invoices SET subtotal=(row_data->>'subtotal')::numeric,
                subtotal_sek=(row_data->>'subtotal_sek')::numeric,vat_amount=(row_data->>'vat_amount')::numeric,
                vat_amount_sek=(row_data->>'vat_amount_sek')::numeric,vat_treatment=row_data->>'vat_treatment'
                WHERE id=target AND company_id=j.company_id;
            END IF;
            FOR item IN SELECT value FROM jsonb_array_elements(r->'items') LOOP
              PERFORM insert_provider_migration_row('supplier_invoice_items',item||jsonb_build_object('supplier_invoice_id',target));
            END LOOP;
          END IF;
        END IF;
      END IF;
      UPDATE migration_source_records SET source_hash=c.source_hash WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
      UPDATE migration_job_chunks SET target_id=target,state='imported',
        receipt=jsonb_build_object('imported',was_new,'link',r->'link','warnings',r->'warnings') WHERE id=c.id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
      -- Codes only: Postgres constraint errors can contain source personal data.
      UPDATE migration_job_chunks SET state='needs_attention',error_phase='import',
        error_code=CASE WHEN message LIKE 'MIGRATION_%' THEN split_part(message,E'\n',1) ELSE SQLSTATE END WHERE id=c.id;
    END;
  END LOOP;
  UPDATE migration_jobs SET failures=0,error_code=NULL WHERE id=j.id;
END $$;

DROP FUNCTION public.provider_migration_counts(uuid);
CREATE FUNCTION public.provider_migration_counts(p_job_id uuid)
 RETURNS TABLE(resource text, total bigint, imported bigint, completed bigint, skipped bigint, needs_attention bigint, pending bigint, fx_unresolved bigint, vat_unresolved bigint, credit_notes_unlinked bigint, credit_notes_linked bigint, unchanged bigint)
 LANGUAGE sql
 SET search_path TO 'public'
AS $function$
  SELECT c.resource,count(*),count(*) FILTER(WHERE c.target_id IS NOT NULL AND COALESCE(c.receipt->>'reason','') NOT IN ('unchanged','source_changed')),count(*) FILTER(WHERE c.state='done'),
    count(*) FILTER(WHERE c.state='skipped' AND COALESCE(c.receipt->>'reason','')<>'unchanged'),count(*) FILTER(WHERE c.state='needs_attention'),
    count(*) FILTER(WHERE c.state IN ('pending','imported','linked','planned')),
    count(*) FILTER(WHERE c.receipt->'warnings'->>'fxUnresolved'='true'),
    count(*) FILTER(WHERE c.receipt->'warnings'->>'vatUnresolved'='true'),
    -- No reference at all (flagged at import), or a reference the link phase
    -- could not resolve. 'imported' means the link phase has not run yet:
    -- such a row is not unlinked, it is not yet paired.
    count(*) FILTER(WHERE c.receipt->'warnings'->>'creditNoteUnlinked'='true'
      OR (c.resource='salesInvoices' AND c.target_id IS NOT NULL AND c.state<>'imported'
        AND jsonb_typeof(c.receipt->'link'->'creditedInvoiceRef')='object'
        AND NOT EXISTS(SELECT 1 FROM invoices i WHERE i.id=c.target_id AND i.company_id=c.company_id
          AND i.credited_invoice_id IS NOT NULL))),
    count(*) FILTER(WHERE c.resource='salesInvoices' AND c.target_id IS NOT NULL
      AND jsonb_typeof(c.receipt->'link'->'creditedInvoiceRef')='object'
      AND EXISTS(SELECT 1 FROM invoices i WHERE i.id=c.target_id AND i.company_id=c.company_id
        AND i.credited_invoice_id IS NOT NULL)),
    count(*) FILTER(WHERE c.receipt->>'reason'='unchanged')
  FROM migration_job_chunks c WHERE c.job_id=p_job_id GROUP BY c.resource;
$function$;

REVOKE ALL ON FUNCTION public.provider_migration_counts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.provider_migration_counts(uuid) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
