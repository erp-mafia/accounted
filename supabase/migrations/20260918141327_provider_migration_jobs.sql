-- Resumable provider registers. Source snapshots are encrypted by the worker.
-- Only the worker can mutate jobs, receipts or source identities. No journal
-- writes: invoice registration/payment links reuse the existing accounting RPCs.
CREATE TABLE public.migration_jobs (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_id uuid REFERENCES public.provider_consents(id) ON DELETE SET NULL,
  provider text NOT NULL,
  account_key text NOT NULL CHECK (length(account_key) > 0),
  resources text[] NOT NULL CHECK (cardinality(resources) BETWEEN 1 AND 4
    AND resources <@ ARRAY['customers','suppliers','salesInvoices','supplierInvoices']),
  fiscal_year_scope jsonb,
  resource_index integer NOT NULL DEFAULT 1,
  next_page integer NOT NULL DEFAULT 1,
  phase text NOT NULL DEFAULT 'discover' CHECK (phase IN ('discover','import','link','reconcile','settle','completed')),
  state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','retry_wait','needs_attention','completed')),
  attempt integer NOT NULL DEFAULT 0,
  worker_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz,
  failures integer NOT NULL DEFAULT 0,
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, company_id)
);
CREATE UNIQUE INDEX migration_jobs_one_active_company ON public.migration_jobs(company_id)
  WHERE state <> 'completed';
CREATE INDEX migration_jobs_queue ON public.migration_jobs(next_attempt_at, updated_at)
  WHERE state IN ('queued','running','retry_wait');

-- One source record is the smallest independently recoverable chunk. A worker
-- commits a bounded group of these in one call; each has its own outcome.
CREATE TABLE public.migration_job_chunks (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  job_id uuid NOT NULL,
  company_id uuid NOT NULL REFERENCES public.companies(id),
  resource text NOT NULL CHECK (resource IN ('customers','suppliers','salesInvoices','supplierInvoices')),
  source_id text NOT NULL CHECK (length(source_id) > 0),
  resource_order integer NOT NULL,
  payload text NOT NULL,
  payload_hash text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','imported','linked','planned','done','skipped','needs_attention')),
  target_id uuid,
  receipt jsonb NOT NULL DEFAULT '{}',
  error_code text,
  error_phase text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, company_id) REFERENCES public.migration_jobs(id, company_id),
  UNIQUE(job_id, resource, source_id)
);
CREATE INDEX migration_job_chunks_work ON public.migration_job_chunks(job_id, state, resource_order, id);
CREATE INDEX migration_job_chunks_company ON public.migration_job_chunks(company_id);

CREATE TABLE public.migration_source_records (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider text NOT NULL,
  account_key text NOT NULL,
  resource text NOT NULL CHECK (resource IN ('customers','suppliers','salesInvoices','supplierInvoices')),
  source_id text NOT NULL,
  target_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id, provider, account_key, resource, source_id)
);
CREATE INDEX migration_source_records_target ON public.migration_source_records(company_id, resource, target_id);

ALTER TABLE public.migration_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migration_job_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.migration_source_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY migration_jobs_read ON public.migration_jobs FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY migration_job_chunks_read ON public.migration_job_chunks FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY migration_source_records_read ON public.migration_source_records FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));
GRANT SELECT ON public.migration_jobs, public.migration_job_chunks, public.migration_source_records TO authenticated;
GRANT ALL ON public.migration_jobs, public.migration_job_chunks, public.migration_source_records TO service_role;
CREATE TRIGGER migration_jobs_updated BEFORE UPDATE ON public.migration_jobs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER migration_job_chunks_updated BEFORE UPDATE ON public.migration_job_chunks
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER migration_source_records_updated BEFORE UPDATE ON public.migration_source_records
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER migration_source_records_audit AFTER INSERT OR UPDATE OR DELETE ON public.migration_source_records
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE FUNCTION public.create_provider_migration_job(
  p_company_id uuid, p_user_id uuid, p_consent_id uuid, p_resources text[], p_scope jsonb
) RETURNS public.migration_jobs LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE c public.provider_consents; j public.migration_jobs; account text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id
    AND role IN ('owner','admin','member')) THEN RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO STRICT c FROM provider_consents WHERE id=p_consent_id AND company_id=p_company_id AND status IN (0,1);
  -- Org identity survives OAuth reconnects. For provider accounts without an
  -- org number, use their tenant id, never the short-lived consent UUID.
  SELECT COALESCE(NULLIF(regexp_replace(c.org_number,'[^[:alnum:]]','','g'),''),
    NULLIF(provider_company_id,'')) INTO account FROM provider_consent_tokens WHERE consent_id=c.id;
  IF account IS NULL THEN RAISE EXCEPTION 'MIGRATION_SOURCE_IDENTITY_MISSING'; END IF;
  IF NOT EXISTS (SELECT 1 FROM sie_imports WHERE company_id=p_company_id AND status='completed') THEN
    RAISE EXCEPTION 'PROVIDER_SIE_IMPORT_REQUIRED';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('provider-migration:'||p_company_id::text,0));
  SELECT * INTO j FROM migration_jobs WHERE company_id=p_company_id AND state<>'completed' FOR UPDATE;
  IF FOUND THEN
    IF j.provider<>c.provider OR j.account_key<>account OR j.resources<>p_resources OR j.fiscal_year_scope IS DISTINCT FROM p_scope THEN
      RAISE EXCEPTION 'MIGRATION_ALREADY_ACTIVE';
    END IF;
    -- A renewed consent may resume the same durable source identity.
    UPDATE migration_jobs SET consent_id=c.id,user_id=p_user_id WHERE id=j.id RETURNING * INTO j;
    RETURN j;
  END IF;
  INSERT INTO migration_jobs(company_id,user_id,consent_id,provider,account_key,resources,fiscal_year_scope)
  VALUES(p_company_id,p_user_id,c.id,c.provider,account,p_resources,p_scope) RETURNING * INTO j;
  RETURN j;
END $$;

CREATE FUNCTION public.claim_provider_migration_job(p_worker_id uuid, p_job_id uuid DEFAULT NULL)
RETURNS public.migration_jobs LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs;
BEGIN
  SELECT * INTO j FROM migration_jobs
    WHERE state IN ('queued','running','retry_wait') AND (p_job_id IS NULL OR id=p_job_id)
      AND (lease_until IS NULL OR lease_until < clock_timestamp())
      AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
    ORDER BY updated_at, id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  UPDATE migration_jobs SET state='running', worker_id=p_worker_id, attempt=attempt+1,
    lease_until=clock_timestamp()+interval '5 minutes', next_attempt_at=NULL
    WHERE id=j.id RETURNING * INTO j;
  RETURN j;
END $$;

CREATE FUNCTION public.lock_provider_migration_job(p_job_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS public.migration_jobs LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs;
BEGIN
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id FOR UPDATE;
  IF j.state<>'running' OR j.worker_id IS DISTINCT FROM p_worker_id OR j.attempt<>p_attempt
    OR j.lease_until<clock_timestamp() THEN RAISE EXCEPTION 'MIGRATION_LEASE_LOST'; END IF;
  IF NOT EXISTS (SELECT 1 FROM company_members WHERE company_id=j.company_id AND user_id=j.user_id
    AND role IN ('owner','admin','member')) THEN RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  IF NOT EXISTS (SELECT 1 FROM provider_consents WHERE id=j.consent_id AND company_id=j.company_id AND status IN (0,1)) THEN
    RAISE EXCEPTION 'PROVIDER_AUTH_EXPIRED';
  END IF;
  UPDATE migration_jobs SET lease_until=clock_timestamp()+interval '5 minutes' WHERE id=j.id;
  RETURN j;
END $$;

CREATE FUNCTION public.save_provider_migration_page(p_job_id uuid,p_worker_id uuid,p_attempt integer,
  p_resource text,p_page integer,p_records jsonb,p_next_page integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; r jsonb;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase<>'discover' OR j.resources[j.resource_index]<>p_resource OR j.next_page<>p_page THEN
    RAISE EXCEPTION 'MIGRATION_CURSOR_CONFLICT';
  END IF;
  IF jsonb_array_length(p_records)>1000 THEN RAISE EXCEPTION 'MIGRATION_PAGE_TOO_LARGE'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    -- Overlapping provider pages may repeat an id. The first persisted source
    -- record wins; counters count distinct records, never repeated page rows.
    INSERT INTO migration_job_chunks(job_id,company_id,resource,source_id,resource_order,payload,payload_hash)
    VALUES(j.id,j.company_id,p_resource,r->>'source_id',j.resource_index,r->>'payload',r->>'payload_hash')
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

-- Preserve database defaults. Identifiers are quoted, and the only callers
-- supply a fixed table selected by resource, never a table from client input.
CREATE FUNCTION public.insert_provider_migration_row(p_table text,p_row jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE cols text; selected text; target uuid;
BEGIN
  IF p_table NOT IN ('customers','suppliers','invoices','supplier_invoices','supplier_invoice_items') THEN
    RAISE EXCEPTION 'MIGRATION_TABLE_FORBIDDEN'; END IF;
  SELECT string_agg(format('%I',key),',' ORDER BY key),string_agg(format('r.%I',key),',' ORDER BY key)
    INTO cols,selected FROM jsonb_object_keys(p_row) AS key;
  EXECUTE format('INSERT INTO public.%I (%s) SELECT %s FROM jsonb_populate_record(NULL::public.%I,$1) r RETURNING id',
    p_table,cols,selected,p_table) INTO target USING p_row;
  RETURN target;
END $$;

CREATE FUNCTION public.resolve_provider_migration_party(p_job_id uuid,p_resource text,p_source_id text,p_row jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; target uuid; candidates uuid[]; tbl text; row_data jsonb;
BEGIN
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id;
  IF p_resource NOT IN ('customers','suppliers') OR NULLIF(p_source_id,'') IS NULL THEN
    RAISE EXCEPTION 'MIGRATION_PARTY_ID_MISSING'; END IF;
  tbl:=p_resource;
  SELECT target_id INTO target FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
    AND account_key=j.account_key AND resource=p_resource AND source_id=p_source_id;
  IF target IS NOT NULL THEN
    EXECUTE format('SELECT array_agg(id) FROM public.%I WHERE id=$1 AND company_id=$2',tbl)
      INTO candidates USING target,j.company_id;
    IF candidates IS NULL THEN RAISE EXCEPTION 'MIGRATION_PARTY_CHANGED'; END IF;
    RETURN target;
  END IF;
  -- Only adopt one unambiguous legacy/native party. Never merge distinct
  -- source ids merely because they share an org number or a name.
  EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I p WHERE company_id=$1
    AND CASE WHEN NULLIF($2->>''org_number'','''') IS NOT NULL
      THEN regexp_replace(COALESCE(org_number,''''),''[^[:alnum:]]'','''',''g'')=regexp_replace($2->>''org_number'',''[^[:alnum:]]'','''',''g'')
      ELSE name=$2->>''name'' END
    AND ($6 OR NOT EXISTS(SELECT 1 FROM migration_source_records m WHERE m.company_id=$1 AND m.resource=$3
      AND m.provider=$4 AND m.account_key=$5 AND m.target_id=p.id AND m.source_id NOT LIKE ''invoice-party:%%''))
    LIMIT 2) candidates',tbl)
    INTO candidates USING j.company_id,p_row,p_resource,j.provider,j.account_key,p_source_id LIKE 'invoice-party:%';
  IF cardinality(candidates)>1 THEN RAISE EXCEPTION 'MIGRATION_PARTY_AMBIGUOUS'; END IF;
  target:=candidates[1];
  IF target IS NULL THEN
    row_data:=p_row||jsonb_build_object('company_id',j.company_id,'user_id',j.user_id);
    target:=insert_provider_migration_row(tbl,row_data);
  END IF;
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
    VALUES(j.company_id,j.user_id,j.provider,j.account_key,p_resource,p_source_id,target);
  RETURN target;
END $$;

CREATE FUNCTION public.commit_provider_migration_records(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; row_data jsonb; item jsonb;
  target uuid; party uuid; tbl text; ids uuid[]; row_result jsonb; was_new boolean; message text;
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
      IF c.resource IN ('customers','suppliers') THEN
        target:=resolve_provider_migration_party(j.id,c.resource,c.source_id,r->'row');
        UPDATE migration_job_chunks SET state='done',target_id=target,receipt='{"imported":true}' WHERE id=c.id;
        CONTINUE;
      END IF;
      tbl:=CASE c.resource WHEN 'salesInvoices' THEN 'invoices' ELSE 'supplier_invoices' END;
      party:=resolve_provider_migration_party(j.id,
        CASE c.resource WHEN 'salesInvoices' THEN 'customers' ELSE 'suppliers' END,r->>'party_source_id',r->'party');
      row_data:=r->'row'||jsonb_build_object('company_id',j.company_id,'user_id',j.user_id,
        CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,party);
      SELECT target_id INTO target FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
        AND account_key=j.account_key AND resource=c.resource AND source_id=c.source_id;
      was_new:=false;
      IF target IS NULL THEN
        -- Adopt a previous import only on number AND party/date/currency/total.
        -- Number-less records are identified exclusively by their source map.
        EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I WHERE company_id=$1
          AND %I=$2->>%L AND %I=($2->>%L)::uuid AND invoice_date=($2->>''invoice_date'')::date
          AND currency=$2->>''currency'' AND total=($2->>''total'')::numeric LIMIT 2) matches',
          tbl,CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'invoice_number' ELSE 'supplier_invoice_number' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END,
          CASE c.resource WHEN 'salesInvoices' THEN 'customer_id' ELSE 'supplier_id' END)
          INTO ids USING j.company_id,row_data;
        IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
        target:=ids[1];
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
            FOR item IN SELECT value FROM jsonb_array_elements(r->'items') LOOP
              PERFORM insert_provider_migration_row('supplier_invoice_items',item||jsonb_build_object('supplier_invoice_id',target));
            END LOOP;
          END IF;
        END IF;
      END IF;
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

CREATE FUNCTION public.commit_provider_migration_followup(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; entry uuid; outcome jsonb; message text;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase NOT IN ('link','reconcile','settle') OR jsonb_array_length(p_records)>25 THEN
    RAISE EXCEPTION 'MIGRATION_PHASE_CONFLICT'; END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(p_records) LOOP
    SELECT * INTO STRICT c FROM migration_job_chunks WHERE id=(r->>'id')::uuid AND job_id=j.id FOR UPDATE;
    IF (j.phase='link' AND c.state<>'imported') OR (j.phase='reconcile' AND c.state<>'linked')
      OR (j.phase='settle' AND c.state<>'planned') THEN CONTINUE; END IF;
    BEGIN
      IF r ? 'error' THEN RAISE EXCEPTION '%',r->>'error'; END IF;
      IF j.phase='link' THEN
        entry:=NULLIF(r->>'journal_entry_id','')::uuid;
        IF entry IS NOT NULL THEN
          IF NOT EXISTS(SELECT 1 FROM journal_entries WHERE id=entry AND company_id=j.company_id AND status='posted') THEN
            RAISE EXCEPTION 'MIGRATION_VOUCHER_UNAVAILABLE'; END IF;
          IF EXISTS(SELECT 1 FROM invoices WHERE company_id=j.company_id AND journal_entry_id=entry AND id<>c.target_id)
            OR EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=j.company_id AND registration_journal_entry_id=entry AND id<>c.target_id) THEN
            RAISE EXCEPTION 'MIGRATION_REGISTRATION_AMBIGUOUS'; END IF;
          -- A matching source ref on multiple invoices is ambiguous across the
          -- whole job, including invoices in other worker batches.
          IF (SELECT count(*) FROM migration_job_chunks other
            JOIN journal_entries e ON e.id=entry
            JOIN fiscal_periods fp ON fp.id=e.fiscal_period_id
            WHERE other.job_id=j.id AND other.target_id IS NOT NULL
              AND other.receipt->'link'->'sourceVoucher'=c.receipt->'link'->'sourceVoucher'
              AND (other.receipt->'link'->>'invoiceDate')::date BETWEEN fp.period_start AND fp.period_end)>1 THEN
            RAISE EXCEPTION 'MIGRATION_REGISTRATION_AMBIGUOUS'; END IF;
          IF c.resource='salesInvoices' THEN
            UPDATE invoices SET journal_entry_id=entry WHERE id=c.target_id AND company_id=j.company_id AND journal_entry_id IS NULL;
          ELSE
            UPDATE supplier_invoices SET registration_journal_entry_id=entry
              WHERE id=c.target_id AND company_id=j.company_id AND registration_journal_entry_id IS NULL;
          END IF;
        END IF;
        UPDATE migration_job_chunks SET state=CASE WHEN resource='supplierInvoices' THEN 'linked' ELSE 'done' END,
          receipt=receipt||jsonb_build_object('registration',r->'report') WHERE id=c.id;
      ELSIF j.phase='reconcile' THEN
        UPDATE migration_job_chunks SET state='planned',receipt=receipt||jsonb_build_object('payment',r->'payment') WHERE id=c.id;
      ELSE
        entry:=NULLIF(c.receipt->'payment'->>'journal_entry_id','')::uuid;
        IF entry IS NOT NULL THEN
          IF (SELECT count(*) FROM migration_job_chunks WHERE job_id=j.id
            AND receipt->'payment'->>'journal_entry_id'=entry::text)>1 THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_AMBIGUOUS'; END IF;
          IF EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE company_id=j.company_id AND journal_entry_id=entry) THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_AMBIGUOUS'; END IF;
          outcome:=link_supplier_invoice_to_voucher(c.target_id,entry,j.user_id,j.company_id,'Provider migration');
          IF NOT COALESCE((outcome->>'ok')::boolean,false) THEN
            RAISE EXCEPTION 'MIGRATION_PAYMENT_REJECTED'; END IF;
        END IF;
        UPDATE migration_job_chunks SET state='done' WHERE id=c.id;
      END IF;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
      UPDATE migration_job_chunks SET state='needs_attention',error_phase=j.phase,
        error_code=CASE WHEN message LIKE 'MIGRATION_%' THEN split_part(message,E'\n',1) ELSE SQLSTATE END WHERE id=c.id;
    END;
  END LOOP;
END $$;

CREATE FUNCTION public.advance_provider_migration_job(p_job_id uuid,p_worker_id uuid,p_attempt integer)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs;
BEGIN
  j:=lock_provider_migration_job(p_job_id,p_worker_id,p_attempt);
  IF j.phase='import' AND NOT EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='pending') THEN
    UPDATE migration_jobs SET phase='link' WHERE id=j.id;
  ELSIF j.phase='link' AND NOT EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='imported') THEN
    UPDATE migration_jobs SET phase='reconcile' WHERE id=j.id;
  ELSIF j.phase='reconcile' AND NOT EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='linked') THEN
    UPDATE migration_jobs SET phase='settle' WHERE id=j.id;
  ELSIF j.phase='settle' AND NOT EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='planned') THEN
    UPDATE migration_jobs SET state=CASE WHEN EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='needs_attention')
      THEN 'needs_attention' ELSE 'completed' END,phase='completed',worker_id=NULL,lease_until=NULL WHERE id=j.id;
    UPDATE provider_consents SET status=1 WHERE id=j.consent_id AND status=0;
  ELSE RAISE EXCEPTION 'MIGRATION_PHASE_NOT_FINISHED'; END IF;
END $$;

CREATE FUNCTION public.release_provider_migration_job(p_job_id uuid,p_worker_id uuid,p_attempt integer,
  p_error_code text DEFAULT NULL,p_retry_seconds integer DEFAULT 0)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN
  -- Does not require a usable consent: an auth failure must itself be recorded.
  UPDATE migration_jobs SET worker_id=NULL,lease_until=NULL,error_code=p_error_code,
    failures=CASE WHEN p_error_code IS NULL THEN 0 ELSE failures+1 END,
    state=CASE WHEN p_error_code IS NULL THEN 'queued' WHEN p_retry_seconds<0 THEN 'needs_attention' ELSE 'retry_wait' END,
    next_attempt_at=CASE WHEN p_retry_seconds>0 THEN clock_timestamp()+make_interval(secs=>LEAST(p_retry_seconds,3600)) ELSE NULL END
    WHERE id=p_job_id AND worker_id=p_worker_id AND attempt=p_attempt AND state='running';
END $$;

CREATE FUNCTION public.retry_provider_migration_job(p_job_id uuid,p_company_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF j.state NOT IN ('needs_attention','retry_wait') THEN RETURN; END IF;
  UPDATE migration_job_chunks SET state=CASE error_phase WHEN 'link' THEN 'imported' WHEN 'reconcile' THEN 'linked' WHEN 'settle' THEN 'planned' ELSE 'pending' END,
    error_code=NULL,error_phase=NULL WHERE job_id=j.id AND state='needs_attention';
  UPDATE migration_jobs SET user_id=p_user_id,state='queued',phase=CASE WHEN phase='discover' THEN 'discover' ELSE 'import' END,
    worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,failures=0,error_code=NULL WHERE id=j.id;
END $$;

CREATE FUNCTION public.provider_migration_counts(p_job_id uuid)
RETURNS TABLE(resource text,total bigint,imported bigint,completed bigint,skipped bigint,needs_attention bigint,pending bigint)
LANGUAGE sql SECURITY INVOKER SET search_path=public AS $$
  SELECT resource,count(*),count(*) FILTER(WHERE target_id IS NOT NULL),count(*) FILTER(WHERE state='done'),
    count(*) FILTER(WHERE state='skipped'),count(*) FILTER(WHERE state='needs_attention'),
    count(*) FILTER(WHERE state IN ('pending','imported','linked','planned'))
  FROM migration_job_chunks WHERE job_id=p_job_id GROUP BY resource;
$$;
REVOKE ALL ON FUNCTION public.provider_migration_counts(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.provider_migration_counts(uuid) TO authenticated,service_role;

DO $$ DECLARE fn regprocedure; BEGIN
  FOR fn IN SELECT oid::regprocedure FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN (
    'create_provider_migration_job','claim_provider_migration_job','lock_provider_migration_job','save_provider_migration_page',
    'insert_provider_migration_row','resolve_provider_migration_party','commit_provider_migration_records',
    'commit_provider_migration_followup','advance_provider_migration_job','release_provider_migration_job','retry_provider_migration_job') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC,anon,authenticated',fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role',fn);
  END LOOP;
END $$;
NOTIFY pgrst,'reload schema';
