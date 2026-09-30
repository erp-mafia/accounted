-- Adopt an already-imported sales invoice on its own unique key.
--
-- A sales invoice number is unique per company (idx_invoices_company_invoice_number),
-- so it is the record's identity. The previous rule also required the invoice's
-- customer_id to equal the party the job had just resolved. For a company whose
-- invoices were imported before source receipts existed, a consumer customer
-- without an org number is never adopted by the party resolver, so the job
-- created a duplicate customer, the invoice no longer matched, the INSERT hit
-- the unique index and the chunk stored a bare 23505 that no resume can fix.
--
-- Now:
--   * Sales invoices: a number match with the same date, currency and total is
--     adopted regardless of customer, and the adopted invoice's customer becomes
--     the source party. A number match that differs raises
--     MIGRATION_INVOICE_NUMBER_TAKEN; nothing is overwritten.
--   * The source customer is mapped to the adopted invoice's customer. When this
--     same job had just created an unverified (no org number), unreferenced
--     duplicate for that source customer, the mapping is moved and the duplicate
--     is removed: the invoice number is stronger identity evidence than a name.
--   * Supplier invoices keep their predicate (supplier + number + date/currency/
--     total + credit-note kind): supplier invoice numbers are only unique per
--     supplier. A live same-supplier number that differs now raises
--     MIGRATION_INVOICE_NUMBER_TAKEN instead of a bare 23505.

-- True when any foreign key still points at the row. Discovered from the
-- catalog so a table added later is covered without editing this function.
CREATE OR REPLACE FUNCTION public.provider_migration_row_referenced(p_table regclass,p_id uuid)
RETURNS boolean LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = public AS $$
DECLARE fk record; hit boolean;
BEGIN
  FOR fk IN
    SELECT c.conrelid::regclass AS tbl, a.attname AS col
    FROM pg_constraint c
    CROSS JOIN LATERAL generate_subscripts(c.confkey,1) AS i
    JOIN pg_attribute pa ON pa.attrelid=c.confrelid AND pa.attnum=c.confkey[i] AND pa.attname='id'
    JOIN pg_attribute a ON a.attrelid=c.conrelid AND a.attnum=c.conkey[i]
    WHERE c.contype='f' AND c.confrelid=p_table
  LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM %s WHERE %I=$1)',fk.tbl,fk.col) INTO hit USING p_id;
    IF hit THEN RETURN true; END IF;
  END LOOP;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION public.provider_migration_row_referenced(regclass,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.provider_migration_row_referenced(regclass,uuid) TO service_role;

-- Map a source customer to the customer of an invoice adopted by number.
CREATE OR REPLACE FUNCTION public.adopt_provider_migration_invoice_party(p_job_id uuid,p_source_id text,p_customer uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; mapped uuid; dup public.customers;
BEGIN
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id;
  IF NULLIF(p_source_id,'') IS NULL THEN RAISE EXCEPTION 'MIGRATION_PARTY_ID_MISSING'; END IF;
  SELECT target_id INTO mapped FROM migration_source_records WHERE company_id=j.company_id AND provider=j.provider
    AND account_key=j.account_key AND resource='customers' AND source_id=p_source_id FOR UPDATE;
  IF mapped IS NULL THEN
    INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
      VALUES(j.company_id,j.user_id,j.provider,j.account_key,'customers',p_source_id,p_customer);
    RETURN p_customer;
  END IF;
  IF mapped=p_customer THEN RETURN p_customer; END IF;
  -- The source customer already maps elsewhere. Fold that customer into the
  -- adopted one only when it is a duplicate this job created: no verified org
  -- number, created by this job's own customers chunk, referenced by nothing,
  -- and the adopted customer is not claimed by another source customer.
  -- Otherwise keep both mappings untouched; the invoice keeps its customer.
  SELECT * INTO dup FROM customers WHERE id=mapped AND company_id=j.company_id FOR UPDATE;
  IF FOUND
    AND NULLIF(regexp_replace(COALESCE(dup.org_number,''),'[^[:alnum:]]','','g'),'') IS NULL
    AND dup.created_at>=j.created_at
    AND EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND resource='customers'
      AND source_id=p_source_id AND target_id=mapped)
    AND NOT EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND resource='customers'
      AND target_id=mapped AND NOT (provider=j.provider AND account_key=j.account_key AND source_id=p_source_id))
    AND NOT EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=j.company_id AND resource='customers'
      AND target_id=p_customer)
    AND NOT provider_migration_row_referenced('public.customers',mapped)
  THEN
    UPDATE migration_source_records SET target_id=p_customer WHERE company_id=j.company_id AND provider=j.provider
      AND account_key=j.account_key AND resource='customers' AND source_id=p_source_id;
    UPDATE migration_job_chunks SET target_id=p_customer WHERE job_id=j.id AND resource='customers' AND target_id=mapped;
    DELETE FROM customers WHERE id=mapped AND company_id=j.company_id;
    -- The party row created alongside the duplicate goes too, if nothing else uses it.
    IF dup.party_id IS NOT NULL AND NOT provider_migration_row_referenced('public.parties',dup.party_id) THEN
      DELETE FROM parties WHERE id=dup.party_id AND company_id=j.company_id;
    END IF;
  END IF;
  RETURN p_customer;
END $$;
REVOKE ALL ON FUNCTION public.adopt_provider_migration_invoice_party(uuid,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.adopt_provider_migration_invoice_party(uuid,text,uuid) TO service_role;

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
      IF c.resource IN ('customers','suppliers') THEN
        target:=resolve_provider_migration_party(j.id,c.resource,c.source_id,r->'row');
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
        -- Supplier invoice numbers are unique per supplier only: adopt on
        -- supplier AND number AND date/currency/total/kind. Number-less records
        -- are identified exclusively by their source map.
        EXECUTE format('SELECT array_agg(id) FROM (SELECT id FROM public.%I WHERE company_id=$1
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
            -- Mirror idx_supplier_invoices_company_supplier_number: a live
            -- same-supplier number that did not match is a named conflict.
            IF NULLIF(row_data->>'supplier_invoice_number','') IS NOT NULL
              AND COALESCE(row_data->>'status','') NOT IN ('credited','reversed')
              AND EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=j.company_id AND supplier_id=party
                AND supplier_invoice_number=row_data->>'supplier_invoice_number'
                AND status NOT IN ('credited','reversed')) THEN
              RAISE EXCEPTION 'MIGRATION_INVOICE_NUMBER_TAKEN';
            END IF;
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

NOTIFY pgrst,'reload schema';
