-- A supplier number reused on every invoice from the same supplier
-- (crm#1039; founder decision 2026-10-06, option B).
--
-- Some suppliers print the same reference on every invoice: an insurer's
-- autogiro or contract reference, typed into the provider's invoice number
-- field month after month. idx_supplier_invoices_company_supplier_number lets
-- only one live invoice per supplier hold a number, so the provider import
-- stored the first of them and refused every later one with
-- MIGRATION_INVOICE_NUMBER_TAKEN.
--
-- commit_provider_migration_records, supplier invoices only:
--   * The same number on another invoice date is another invoice. It is stored
--     without a supplier number (NULL, allowed since 20261005225009) and the
--     reused reference becomes its payment_reference. The receipt carries the
--     warning numberAsPaymentReference.
--   * The same number and the same date stays a duplicate refusal
--     (MIGRATION_INVOICE_NUMBER_TAKEN), also against an invoice stored this
--     way. So does a record that already carries another payment reference:
--     storing both is not possible, and dropping one loses data.
--   * A run that has lost its source map adopts an invoice stored this way on
--     its header (supplier, reference, date, currency, total, kind), the same
--     evidence a numbered invoice is adopted on.
--   * The unique index for real numbers is unchanged. Sales invoices are
--     unchanged.
--
-- complete_bokio_supplier_invoice: its source identity check accepts such an
-- invoice (no number, payment_reference equal to the source number), so the
-- Bokio completion pass can still complete it.
--
-- Both functions are copied verbatim from their latest definitions
-- (20260925205556 and 20260922172815, identical to production) with only the
-- edits above. Privileges are kept by CREATE OR REPLACE.

CREATE OR REPLACE FUNCTION public.commit_provider_migration_records(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; row_data jsonb; item jsonb;
  target uuid; party uuid; tbl text; ids uuid[]; row_result jsonb; was_new boolean; message text;
  legacy public.invoices; reused boolean;
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
      reused:=false;
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
        -- An invoice stored by the reused-number rule below has no number and
        -- the source number as payment_reference: the same header is the same
        -- invoice on a run that has lost its source map.
        IF target IS NULL AND c.resource='supplierInvoices'
          AND NULLIF(row_data->>'supplier_invoice_number','') IS NOT NULL THEN
          SELECT array_agg(id) INTO ids FROM (SELECT id FROM supplier_invoices WHERE company_id=j.company_id
            AND supplier_id=party AND supplier_invoice_number IS NULL
            AND payment_reference=row_data->>'supplier_invoice_number'
            AND invoice_date=(row_data->>'invoice_date')::date AND currency=row_data->>'currency'
            AND total=(row_data->>'total')::numeric
            AND is_credit_note=COALESCE((row_data->>'is_credit_note')::boolean,false) LIMIT 2) moved;
          IF cardinality(ids)>1 THEN RAISE EXCEPTION 'MIGRATION_INVOICE_AMBIGUOUS'; END IF;
          target:=ids[1];
        END IF;
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
              -- A number the supplier puts on every invoice (an autogiro or
              -- contract reference, crm#1039): another invoice date makes it
              -- another invoice. It is stored without a number, the reference
              -- kept as its payment_reference. The same number and date (also
              -- against an invoice stored this way), or another payment
              -- reference already on the record, stays a refusal.
              IF EXISTS(SELECT 1 FROM supplier_invoices WHERE company_id=j.company_id AND supplier_id=party
                  AND status NOT IN ('credited','reversed') AND invoice_date=(row_data->>'invoice_date')::date
                  AND (supplier_invoice_number=row_data->>'supplier_invoice_number'
                    OR (supplier_invoice_number IS NULL AND payment_reference=row_data->>'supplier_invoice_number')))
                OR (NULLIF(row_data->>'payment_reference','') IS NOT NULL
                  AND row_data->>'payment_reference'<>row_data->>'supplier_invoice_number') THEN
                RAISE EXCEPTION 'MIGRATION_INVOICE_NUMBER_TAKEN';
              END IF;
              row_data:=row_data||jsonb_build_object('supplier_invoice_number',NULL,
                'payment_reference',row_data->>'supplier_invoice_number');
              reused:=true;
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
        receipt=jsonb_build_object('imported',was_new,'link',r->'link','warnings',CASE WHEN reused
          THEN CASE WHEN jsonb_typeof(r->'warnings')='object' THEN r->'warnings' ELSE '{}'::jsonb END
            ||'{"numberAsPaymentReference":true}'::jsonb
          ELSE r->'warnings' END) WHERE id=c.id;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS message=MESSAGE_TEXT;
      -- Codes only: Postgres constraint errors can contain source personal data.
      UPDATE migration_job_chunks SET state='needs_attention',error_phase='import',
        error_code=CASE WHEN message LIKE 'MIGRATION_%' THEN split_part(message,E'\n',1) ELSE SQLSTATE END WHERE id=c.id;
    END;
  END LOOP;
  UPDATE migration_jobs SET failures=0,error_code=NULL WHERE id=j.id;
END $$;

CREATE OR REPLACE FUNCTION public.complete_bokio_supplier_invoice(p_company_id uuid,p_consent_id uuid,p_invoice_id uuid,
  p_run_id uuid,p_source jsonb,p_expected jsonb,p_plan jsonb,p_dry_run boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE
  c record; w bokio_supplier_completion_work; i supplier_invoices; previous bokio_supplier_completion_entries;
  je journal_entries; before_row jsonb; after_row jsonb; result jsonb; attachment jsonb;
  header jsonb:=p_plan->'header'; rows jsonb:=p_plan->'items'; item jsonb;
  voucher_id uuid:=(p_plan->>'voucher_id')::uuid; document_uuid uuid; target uuid;
  row_count integer:=0; net numeric; vat numeric; ap numeric; bank numeric; booked_vat numeric;
  document_count integer; upload_count integer; resolved_count integer;
  changed boolean:=false; header_changed boolean:=false;
  previous_metadata jsonb; batch_item jsonb; batch_receipts jsonb:='[]'::jsonb; batch_expected jsonb;
  import_mode boolean:=COALESCE(p_plan->>'origin'='import',false); key text; provenance_new boolean:=false;
  dry boolean:=COALESCE(p_dry_run,true); outcome text:=COALESCE(p_plan->>'reason','unresolved');
  event_uuid uuid; payment_date date; fabricated boolean; actor jsonb;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role' AND (auth.uid() IS NULL OR NOT EXISTS(
    SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=auth.uid() AND role IN ('owner','admin','member')
  )) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT (SELECT cm.user_id FROM company_members cm WHERE cm.company_id=pc.company_id AND cm.role='owner' ORDER BY cm.user_id LIMIT 1) AS user_id,COALESCE(NULLIF(regexp_replace(pc.org_number,'[^[:alnum:]]','','g'),''),NULLIF(t.provider_company_id,''),pc.id::text) account_key
    INTO c FROM provider_consents pc JOIN provider_consent_tokens t ON t.consent_id=pc.id
    WHERE pc.id=p_consent_id AND pc.company_id=p_company_id AND pc.provider='bokio' AND pc.status IN (0,1);
  IF NOT FOUND THEN RAISE EXCEPTION 'BOKIO_CONSENT_NOT_FOUND'; END IF;
  IF import_mode AND (p_plan - ARRAY['origin','voucher_id','voucher_kind'])<>'{}'::jsonb THEN RAISE EXCEPTION 'BOKIO_IMPORT_PLAN_INVALID'; END IF;
  IF import_mode AND p_invoice_id IS NULL THEN
    IF jsonb_typeof(p_source) IS DISTINCT FROM 'array' OR jsonb_array_length(p_source)>100 THEN
      RAISE EXCEPTION 'BOKIO_IMPORT_BATCH_INVALID'; END IF;
    FOR batch_item IN SELECT value FROM jsonb_array_elements(p_source) LOOP
      SELECT jsonb_build_object('updated_at',updated_at,'total',total,'supplier_id',supplier_id) INTO batch_expected
        FROM supplier_invoices WHERE id=(batch_item->>'invoice_id')::uuid AND company_id=p_company_id;
      batch_receipts:=batch_receipts||jsonb_build_array(complete_bokio_supplier_invoice(p_company_id,p_consent_id,
        (batch_item->>'invoice_id')::uuid,p_run_id,batch_item->'source',batch_expected,
        jsonb_build_object('origin','import')||CASE WHEN batch_item->>'voucher_id' IS NOT NULL
          THEN jsonb_build_object('voucher_id',batch_item->>'voucher_id','voucher_kind','cash_purchase') ELSE '{}'::jsonb END,dry));
    END LOOP;
    RETURN jsonb_build_object('receipts',batch_receipts);
  END IF;
  IF NOT dry AND NOT import_mode THEN
    SELECT * INTO w FROM bokio_supplier_completion_work WHERE company_id=p_company_id FOR UPDATE;
    IF NOT FOUND OR p_run_id IS NULL OR w.run_id IS DISTINCT FROM p_run_id OR w.lease_until IS NULL OR w.lease_until<clock_timestamp()
      OR w.consent_id IS DISTINCT FROM p_consent_id OR w.account_key<>c.account_key THEN RAISE EXCEPTION 'BOKIO_COMPLETION_LEASE_LOST'; END IF;
    SELECT * INTO previous FROM bokio_supplier_completion_entries WHERE company_id=p_company_id AND invoice_id=p_invoice_id;
    IF previous.run_id=p_run_id THEN RETURN previous.receipt; END IF;
  END IF;
  -- Same lock order as settlement attachment, including when called inside
  -- this transaction. No provider/network operation holds these locks.
  IF voucher_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('si-settlement-voucher:'||voucher_id::text,0));
  END IF;
  SELECT * INTO i FROM supplier_invoices WHERE id=p_invoice_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('outcome','not_found','changed',false); END IF;
  before_row:=jsonb_build_object('subtotal',i.subtotal,'subtotal_sek',i.subtotal_sek,'vat_amount',i.vat_amount,'vat_amount_sek',i.vat_amount_sek,'document_id',i.document_id,'paid_at',i.paid_at);
  IF i.updated_at IS DISTINCT FROM (p_expected->>'updated_at')::timestamptz
    OR i.total IS DISTINCT FROM (p_expected->>'total')::numeric
    OR i.supplier_id IS DISTINCT FROM (p_expected->>'supplier_id')::uuid THEN
    RETURN jsonb_build_object('outcome','concurrent_change','changed',false);
  END IF;
  IF p_source IS NOT NULL THEN
    IF COALESCE(p_source->>'id','')='' OR i.total IS DISTINCT FROM (p_source->>'total')::numeric
      OR i.currency IS DISTINCT FROM p_source->>'currency'
      OR i.invoice_date IS DISTINCT FROM (p_source->>'invoice_date')::date
      OR (i.supplier_invoice_number IS DISTINCT FROM p_source->>'invoice_number'
        -- A reused source number the import stored as payment_reference
        -- (commit_provider_migration_records) is the same invoice.
        AND NOT (i.supplier_invoice_number IS NULL
          AND i.payment_reference IS NOT DISTINCT FROM p_source->>'invoice_number'))
      OR i.supplier_id IS DISTINCT FROM (p_source->>'supplier_id')::uuid
      OR COALESCE(i.is_credit_note,false) IS DISTINCT FROM COALESCE((p_source->>'is_credit_note')::boolean,false) THEN
      RAISE EXCEPTION 'BOKIO_SOURCE_IDENTITY_MISMATCH';
    END IF;
    SELECT target_id,source_metadata INTO target,previous_metadata FROM migration_source_records WHERE company_id=p_company_id AND provider='bokio'
      AND account_key=c.account_key AND resource='supplierInvoices' AND source_id=p_source->>'id';
    provenance_new:=target IS NULL OR NOT (previous_metadata ? 'rule_version');
    IF import_mode AND target IS NULL AND i.created_at<now()-interval '15 minutes' THEN RAISE EXCEPTION 'BOKIO_IMPORT_NOT_FRESH'; END IF;
    IF target IS NOT NULL AND target<>i.id THEN RAISE EXCEPTION 'BOKIO_SOURCE_IDENTITY_MISMATCH'; END IF;
    IF EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=p_company_id AND provider='bokio'
      AND account_key=c.account_key AND resource='supplierInvoices' AND target_id=i.id AND source_id<>p_source->>'id') THEN
      RAISE EXCEPTION 'BOKIO_SOURCE_IDENTITY_MISMATCH';
    END IF;
  ELSIF import_mode OR header IS NOT NULL OR rows IS NOT NULL OR voucher_id IS NOT NULL THEN
    RAISE EXCEPTION 'BOKIO_SOURCE_REQUIRED';
  END IF;
  IF voucher_id IS NOT NULL THEN
    SELECT * INTO je FROM journal_entries WHERE id=voucher_id AND company_id=p_company_id;
    IF NOT FOUND OR je.status<>'posted' OR je.reversed_by_id IS NOT NULL OR je.source_type IN ('opening_balance','storno')
      OR je.source_voucher_series IS DISTINCT FROM p_source#>>'{voucher,series}'
      OR je.source_voucher_number IS DISTINCT FROM (p_source#>>'{voucher,number}')::integer
      OR je.entry_date IS DISTINCT FROM (p_source#>>'{voucher,date}')::date THEN
      RAISE EXCEPTION 'BOKIO_VOUCHER_MISMATCH';
    END IF;
    SELECT COALESCE(sum(credit_amount-debit_amount) FILTER(WHERE account_number LIKE '244%'),0),
      COALESCE(sum(credit_amount-debit_amount) FILTER(WHERE account_number LIKE '19%'),0),
      COALESCE(sum(debit_amount-credit_amount) FILTER(WHERE account_number IN ('2640','2641')),0)
      INTO ap,bank,booked_vat FROM journal_entry_lines WHERE journal_entry_id=voucher_id;
  END IF;
  IF i.currency='SEK' AND NOT COALESCE(i.is_credit_note,false) AND p_source IS NOT NULL THEN
    IF header IS NOT NULL THEN
      net:=(header->>'subtotal')::numeric; vat:=(header->>'vat_amount')::numeric;
      IF net IS NULL OR vat IS NULL OR net<0 OR vat<0 OR net+vat<>i.total
        OR net::text IN ('NaN','Infinity','-Infinity') OR vat::text IN ('NaN','Infinity','-Infinity') THEN
        RAISE EXCEPTION 'BOKIO_HEADER_INVALID';
      END IF;
      IF p_source->>'vat_source'='voucher' AND (voucher_id IS NULL OR round(booked_vat,2)<>vat
        OR NOT ((round(ap,2)=i.total AND bank=0) OR (ap=0 AND round(bank,2)=i.total AND NOT EXISTS(SELECT 1 FROM journal_entry_lines WHERE journal_entry_id=voucher_id AND account_number LIKE '244%')))
        OR EXISTS(SELECT 1 FROM journal_entry_lines WHERE journal_entry_id=voucher_id AND account_number LIKE '26%'
          AND account_number NOT IN ('2640','2641'))) THEN RAISE EXCEPTION 'BOKIO_VAT_NOT_CORROBORATED'; END IF;
      IF COALESCE(p_source->>'vat_source','') NOT IN ('voucher','invoice_lines') THEN RAISE EXCEPTION 'BOKIO_VAT_NOT_CORROBORATED'; END IF;
      -- Missing header and existing rows are separate eligibility decisions.
      IF i.subtotal=i.total AND i.vat_amount=0 AND (NOT EXISTS(
        SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=i.id
      ) OR EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=i.id
        HAVING sum(line_total)=net AND sum(vat_amount)=vat)) THEN
        header_changed:=i.subtotal<>net OR i.vat_amount<>vat;
        i.subtotal:=net; i.subtotal_sek:=net; i.vat_amount:=vat; i.vat_amount_sek:=vat;
      END IF;
    END IF;
    IF rows IS NOT NULL AND NOT EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=i.id) THEN
      IF jsonb_typeof(rows) IS DISTINCT FROM 'array' OR jsonb_array_length(rows) NOT BETWEEN 1 AND 1000 THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
      SELECT sum((r->>'line_total')::numeric),sum((r->>'vat_amount')::numeric) INTO net,vat FROM jsonb_array_elements(rows) r;
      IF net IS DISTINCT FROM i.subtotal OR vat IS DISTINCT FROM i.vat_amount THEN RAISE EXCEPTION 'BOKIO_ROWS_MISMATCH'; END IF;
      FOR item IN SELECT value FROM jsonb_array_elements(rows) LOOP
        IF jsonb_typeof(item) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        FOREACH key IN ARRAY ARRAY['description','quantity','unit_price','line_total','vat_amount','vat_rate','account_number','sort_order'] LOOP
          IF item->>key IS NULL THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        END LOOP;
        IF EXISTS(SELECT 1 FROM jsonb_object_keys(item) k WHERE k NOT IN
          ('description','quantity','unit','unit_price','line_total','vat_amount','vat_rate','account_number','sort_order'))
          OR item->>'account_number' !~ '^[0-9]{4}$'
          OR (item->>'quantity')::numeric<=0 OR (item->>'sort_order')::integer<0 THEN RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        FOREACH key IN ARRAY ARRAY['quantity','unit_price','line_total','vat_amount','vat_rate'] LOOP
          IF (item->>key)::numeric<0 OR (item->>key)::numeric::text IN ('NaN','Infinity','-Infinity') THEN
            RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
        END LOOP;
        IF round((item->>'line_total')::numeric*(item->>'vat_rate')::numeric,2)<>(item->>'vat_amount')::numeric THEN
          RAISE EXCEPTION 'BOKIO_ROWS_INVALID'; END IF;
      END LOOP;
      row_count:=jsonb_array_length(rows);
      IF NOT dry THEN
        INSERT INTO supplier_invoice_items(supplier_invoice_id,sort_order,description,quantity,unit,unit_price,line_total,account_number,vat_rate,vat_amount)
        SELECT i.id,r.sort_order,r.description,r.quantity,r.unit,r.unit_price,r.line_total,r.account_number,r.vat_rate,r.vat_amount
        FROM jsonb_to_recordset(rows) r(sort_order integer,description text,quantity numeric,unit text,unit_price numeric,
          line_total numeric,account_number text,vat_rate numeric,vat_amount numeric);
      END IF;
    END IF;
    IF voucher_id IS NOT NULL AND p_plan->>'voucher_kind'='cash_purchase' AND round(bank,2)=i.total AND ap=0
      AND (p_source->>'remaining_amount')::numeric=0 AND i.registration_journal_entry_id IS NULL THEN
      IF i.status='paid' THEN
        attachment:=attach_supplier_invoice_settlement_voucher(i.id,voucher_id,COALESCE(auth.uid(),c.user_id),p_company_id,
          'Bokio source invoice reference',dry);
        IF COALESCE((attachment->>'ok')::boolean,false) THEN payment_date:=(attachment->>'payment_date')::date;
        ELSIF attachment->>'code'='ATTACH_SI_SETTLEMENT_ALREADY_LINKED' THEN
          SELECT p.payment_date INTO payment_date FROM supplier_invoice_payments p
            WHERE p.company_id=p_company_id AND p.supplier_invoice_id=i.id AND p.journal_entry_id=voucher_id;
        END IF;
      ELSE attachment:=jsonb_build_object('ok',false,'code','PAYMENT_REFRESH_REQUIRED');
      END IF;
    END IF;
    fabricated:=i.status='paid' AND i.created_at<'2026-09-20T14:09:27Z'::timestamptz
      AND i.paid_at=(i.invoice_date::timestamp AT TIME ZONE 'UTC')
      AND NOT EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE supplier_invoice_id=i.id AND journal_entry_id IS DISTINCT FROM voucher_id);
    IF payment_date IS NOT NULL AND (i.paid_at IS NULL OR fabricated) THEN
      i.paid_at:=(payment_date::timestamp+interval '12 hours') AT TIME ZONE 'UTC';
    ELSIF fabricated AND COALESCE((p_plan->>'clear_fabricated_date')::boolean,false) AND attachment IS NULL THEN i.paid_at:=NULL;
    END IF;
  END IF;
  IF i.document_id IS NULL AND jsonb_typeof(p_source->'upload_ids')='array' THEN
    SELECT count(DISTINCT value) INTO upload_count FROM jsonb_array_elements_text(p_source->'upload_ids');
    SELECT count(DISTINCT m.source_id),count(DISTINCT m.target_id),(array_agg(m.target_id))[1]
      INTO resolved_count,document_count,document_uuid
      FROM migration_source_records m JOIN document_attachments d ON d.id=m.target_id AND d.company_id=p_company_id
      WHERE m.company_id=p_company_id AND m.provider='bokio' AND m.account_key=c.account_key AND m.resource='uploads'
        AND m.source_id IN (SELECT value FROM jsonb_array_elements_text(p_source->'upload_ids'));
    IF upload_count>0 AND resolved_count=upload_count AND document_count=1 THEN i.document_id:=document_uuid; END IF;
  END IF;
  after_row:=jsonb_build_object('subtotal',i.subtotal,'subtotal_sek',i.subtotal_sek,'vat_amount',i.vat_amount,'vat_amount_sek',i.vat_amount_sek,'document_id',i.document_id,'paid_at',i.paid_at);
  changed:=before_row IS DISTINCT FROM after_row OR row_count>0 OR COALESCE((attachment->>'ok')::boolean,false);
  IF changed THEN outcome:='completed'; END IF;
  IF NOT dry AND (changed OR (import_mode AND provenance_new)) THEN
    UPDATE supplier_invoices SET subtotal=i.subtotal,subtotal_sek=i.subtotal_sek,vat_amount=i.vat_amount,vat_amount_sek=i.vat_amount_sek,
      document_id=i.document_id,paid_at=i.paid_at WHERE id=i.id AND company_id=p_company_id;
    event_uuid:=gen_random_uuid();
    actor:=CASE WHEN auth.uid() IS NOT NULL THEN jsonb_build_object('type','user','id',auth.uid())
      ELSE jsonb_build_object('type','cron','id','complete-bokio-supplier-invoices') END;
    INSERT INTO processing_history(event_id,company_id,correlation_id,aggregate_type,aggregate_id,event_type,payload,payload_schema_version,actor,occurred_at)
      VALUES(event_uuid,p_company_id,p_run_id,'SupplierInvoice',i.id,'SupplierInvoiceCompleted',
        jsonb_build_object('source',CASE WHEN import_mode THEN 'bokio-import' ELSE 'complete-bokio-supplier-invoices' END,'provider','bokio','consent_id',p_consent_id,
          'source_id',p_source->>'id','rule_version',1,'vat_source',p_source->>'vat_source',
          'voucher_id',voucher_id,'before',before_row,'after',after_row,'rows_inserted',row_count,'settlement',attachment),1,actor,clock_timestamp());
  END IF;
  result:=jsonb_build_object('outcome',outcome,'changed',changed,'dry_run',dry,'rows',row_count,
    'header_updated',header_changed,'event_id',event_uuid,'settlement',attachment,'before',before_row,'after',after_row);
  IF NOT dry THEN
    IF p_source IS NOT NULL THEN
      INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id,source_metadata)
        VALUES(p_company_id,COALESCE(auth.uid(),c.user_id),'bokio',c.account_key,'supplierInvoices',p_source->>'id',i.id,
          jsonb_build_object('upload_ids',COALESCE(p_source->'upload_ids','[]'::jsonb),'vat_source',p_source->>'vat_source','voucher',p_source->'voucher','rule_version',1))
        ON CONFLICT(company_id,provider,account_key,resource,source_id) DO UPDATE SET source_metadata=EXCLUDED.source_metadata;
    END IF;
    IF NOT import_mode THEN
    INSERT INTO bokio_supplier_completion_entries(company_id,invoice_id,source_id,outcome,run_id,receipt,next_attempt_at)
      VALUES(p_company_id,i.id,p_source->>'id',outcome,p_run_id,result,now()+CASE WHEN outcome IN ('provider_evidence_deferred','write_rejected') THEN interval '15 minutes' ELSE interval '1 day' END)
      ON CONFLICT(company_id,invoice_id) DO UPDATE SET source_id=EXCLUDED.source_id,outcome=EXCLUDED.outcome,
        run_id=EXCLUDED.run_id,receipt=EXCLUDED.receipt,next_attempt_at=EXCLUDED.next_attempt_at;
    END IF;
  END IF;
  RETURN result;
END $$;

NOTIFY pgrst,'reload schema';
