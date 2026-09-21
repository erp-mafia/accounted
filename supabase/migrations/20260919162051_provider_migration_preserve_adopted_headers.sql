-- Preserve user-entered supplier VAT fields when adopting an existing invoice.
CREATE OR REPLACE FUNCTION public.commit_provider_migration_records(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
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
