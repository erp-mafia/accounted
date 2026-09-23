-- Opt-in supplier recovery. No company is enrolled and no invoice changes on
-- migration. Source identities and receipts survive retries; provider payloads
-- and credentials are not copied into recovery state.
ALTER TABLE public.migration_source_records ADD COLUMN source_metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.migration_source_records DROP CONSTRAINT migration_source_records_resource_check;
ALTER TABLE public.migration_source_records ADD CONSTRAINT migration_source_records_resource_check
  CHECK (resource IN ('customers','suppliers','salesInvoices','supplierInvoices','uploads'));

CREATE TABLE public.bokio_supplier_completion_work (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL UNIQUE REFERENCES public.companies(id),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  consent_id uuid REFERENCES public.provider_consents(id) ON DELETE SET NULL,
  account_key text NOT NULL,
  run_id uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX bokio_supplier_completion_due ON public.bokio_supplier_completion_work(next_attempt_at);
CREATE INDEX bokio_supplier_completion_user ON public.bokio_supplier_completion_work(user_id);
CREATE INDEX bokio_supplier_completion_consent ON public.bokio_supplier_completion_work(consent_id);
CREATE TABLE public.bokio_supplier_completion_entries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.bokio_supplier_completion_work(company_id),
  invoice_id uuid NOT NULL REFERENCES public.supplier_invoices(id),
  source_id text,
  outcome text NOT NULL,
  run_id uuid NOT NULL,
  receipt jsonb NOT NULL,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(company_id,invoice_id)
);
CREATE INDEX bokio_supplier_completion_invoice ON public.bokio_supplier_completion_entries(invoice_id);
ALTER TABLE public.bokio_supplier_completion_work ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bokio_supplier_completion_entries ENABLE ROW LEVEL SECURITY;
CREATE POLICY bokio_supplier_work_read ON public.bokio_supplier_completion_work FOR SELECT TO authenticated
  USING(company_id IN (SELECT public.user_company_ids()));
CREATE POLICY bokio_supplier_entries_read ON public.bokio_supplier_completion_entries FOR SELECT TO authenticated
  USING(company_id IN (SELECT public.user_company_ids()));
REVOKE ALL ON public.bokio_supplier_completion_work,public.bokio_supplier_completion_entries FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.bokio_supplier_completion_work,public.bokio_supplier_completion_entries TO authenticated;
GRANT ALL ON public.bokio_supplier_completion_work,public.bokio_supplier_completion_entries TO service_role;
CREATE TRIGGER bokio_supplier_work_updated BEFORE UPDATE ON public.bokio_supplier_completion_work
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER bokio_supplier_entries_updated BEFORE UPDATE ON public.bokio_supplier_completion_entries
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER bokio_supplier_work_audit AFTER INSERT OR UPDATE OR DELETE ON public.bokio_supplier_completion_work
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER bokio_supplier_entries_audit AFTER INSERT OR UPDATE OR DELETE ON public.bokio_supplier_completion_entries
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
ALTER TABLE public.processing_history DROP CONSTRAINT processing_history_aggregate_type_check;
ALTER TABLE public.processing_history ADD CONSTRAINT processing_history_aggregate_type_check
  CHECK (aggregate_type IN ('Document','BankTransaction','MatchProposal','Verifikation','CounterpartyTemplate','Period',
    'Migration','System','AIProposal','AIRequest','Invoice','SupplierInvoice'));
INSERT INTO public.processing_event_types(event_type) VALUES('SupplierInvoiceCompleted') ON CONFLICT DO NOTHING;

-- A narrow definer is needed because session callers may read source mappings
-- and recovery state, but cannot write those tables directly.
CREATE FUNCTION public.claim_bokio_supplier_completion(p_company_id uuid,p_consent_id uuid,p_run_id uuid,
  p_start boolean DEFAULT false,p_release boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE c record; w bokio_supplier_completion_work;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role' AND (auth.uid() IS NULL OR NOT EXISTS(
    SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=auth.uid() AND role IN ('owner','admin','member')
  )) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  IF p_release THEN
    UPDATE bokio_supplier_completion_work SET run_id=NULL,lease_until=NULL,next_attempt_at=now()+interval '1 minute'
      WHERE company_id=p_company_id AND consent_id=p_consent_id AND run_id=p_run_id;
    RETURN jsonb_build_object('released',FOUND);
  END IF;
  SELECT (SELECT cm.user_id FROM company_members cm WHERE cm.company_id=pc.company_id AND cm.role='owner' ORDER BY cm.user_id LIMIT 1) AS user_id,COALESCE(NULLIF(regexp_replace(pc.org_number,'[^[:alnum:]]','','g'),''),NULLIF(t.provider_company_id,''),pc.id::text) account_key
    INTO c FROM provider_consents pc JOIN provider_consent_tokens t ON t.consent_id=pc.id
    WHERE pc.id=p_consent_id AND pc.company_id=p_company_id AND pc.provider='bokio' AND pc.status IN (0,1);
  IF NOT FOUND THEN RAISE EXCEPTION 'BOKIO_CONSENT_NOT_FOUND'; END IF;
  IF p_start THEN
    INSERT INTO bokio_supplier_completion_work(company_id,user_id,consent_id,account_key)
      VALUES(p_company_id,COALESCE(auth.uid(),c.user_id),p_consent_id,c.account_key) ON CONFLICT(company_id) DO NOTHING;
  END IF;
  SELECT * INTO w FROM bokio_supplier_completion_work WHERE company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('claimed',false); END IF;
  IF w.consent_id IS DISTINCT FROM p_consent_id OR w.account_key<>c.account_key THEN RAISE EXCEPTION 'MIGRATION_SOURCE_IDENTITY_CHANGED'; END IF;
  IF w.lease_until>clock_timestamp() THEN RETURN jsonb_build_object('claimed',false); END IF;
  UPDATE bokio_supplier_completion_work SET run_id=p_run_id,lease_until=clock_timestamp()+interval '4 minutes'
    WHERE company_id=p_company_id;
  RETURN jsonb_build_object('claimed',true,'account_key',w.account_key);
END $$;

CREATE FUNCTION public.record_bokio_upload(p_company_id uuid,p_consent_id uuid,p_upload_id text,p_document_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public
SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE c record; existing uuid; candidate record; document_ids uuid[]; expected_count integer; resolved_count integer;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role' AND (auth.uid() IS NULL OR NOT EXISTS(
    SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=auth.uid() AND role IN ('owner','admin','member')
  )) THEN RAISE EXCEPTION 'FORBIDDEN' USING ERRCODE='42501'; END IF;
  SELECT (SELECT cm.user_id FROM company_members cm WHERE cm.company_id=pc.company_id AND cm.role='owner' ORDER BY cm.user_id LIMIT 1) AS user_id,COALESCE(NULLIF(regexp_replace(pc.org_number,'[^[:alnum:]]','','g'),''),NULLIF(t.provider_company_id,''),pc.id::text) account_key
    INTO c FROM provider_consents pc JOIN provider_consent_tokens t ON t.consent_id=pc.id
    WHERE pc.id=p_consent_id AND pc.company_id=p_company_id AND pc.provider='bokio' AND pc.status IN (0,1);
  IF NOT FOUND OR COALESCE(p_upload_id,'')='' OR NOT EXISTS(
    SELECT 1 FROM document_attachments WHERE id=p_document_id AND company_id=p_company_id AND journal_entry_id IS NOT NULL
  ) THEN RAISE EXCEPTION 'BOKIO_UPLOAD_INVALID'; END IF;
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
    VALUES(p_company_id,COALESCE(auth.uid(),c.user_id),'bokio',c.account_key,'uploads',p_upload_id,p_document_id)
    ON CONFLICT(company_id,provider,account_key,resource,source_id) DO NOTHING;
  SELECT target_id INTO existing FROM migration_source_records WHERE company_id=p_company_id AND provider='bokio'
    AND account_key=c.account_key AND resource='uploads' AND source_id=p_upload_id;
  IF existing<>p_document_id THEN RAISE EXCEPTION 'BOKIO_UPLOAD_IDENTITY_CONFLICT'; END IF;
  -- A document becomes primary only after every reference resolves, and all
  -- references resolve to the same retained attachment. Partial imports wait.
  FOR candidate IN SELECT si.id,m.source_metadata FROM supplier_invoices si
    JOIN migration_source_records m ON m.target_id=si.id AND m.company_id=si.company_id
    WHERE si.company_id=p_company_id AND si.document_id IS NULL AND m.provider='bokio'
      AND m.account_key=c.account_key AND m.resource='supplierInvoices'
      AND m.source_metadata->'upload_ids' ? p_upload_id
    ORDER BY si.id FOR UPDATE OF si LOOP
    SELECT count(DISTINCT value) INTO expected_count FROM jsonb_array_elements_text(candidate.source_metadata->'upload_ids');
    SELECT count(DISTINCT m.source_id),array_agg(DISTINCT m.target_id) INTO resolved_count,document_ids
      FROM migration_source_records m JOIN document_attachments d ON d.id=m.target_id AND d.company_id=p_company_id
      WHERE m.company_id=p_company_id AND m.provider='bokio' AND m.account_key=c.account_key AND m.resource='uploads'
        AND candidate.source_metadata->'upload_ids' ? m.source_id;
    IF expected_count>0 AND resolved_count=expected_count AND cardinality(document_ids)=1 THEN
      UPDATE supplier_invoices SET document_id=document_ids[1] WHERE id=candidate.id AND document_id IS NULL;
      IF FOUND THEN
        INSERT INTO processing_history(event_id,company_id,correlation_id,aggregate_type,aggregate_id,event_type,payload,payload_schema_version,actor,occurred_at)
          VALUES(gen_random_uuid(),p_company_id,gen_random_uuid(),'SupplierInvoice',candidate.id,'SupplierInvoiceCompleted',
            jsonb_build_object('source','bokio-upload','provider','bokio','rule_version',1,
              'before',jsonb_build_object('document_id',NULL),'after',jsonb_build_object('document_id',document_ids[1])),1,
            jsonb_build_object('type','user','id',COALESCE(auth.uid(),c.user_id)),clock_timestamp());
      END IF;
    END IF;
  END LOOP;
END $$;

CREATE FUNCTION public.complete_bokio_supplier_invoice(p_company_id uuid,p_consent_id uuid,p_invoice_id uuid,
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
      OR i.supplier_invoice_number IS DISTINCT FROM p_source->>'invoice_number'
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

CREATE OR REPLACE FUNCTION public.commit_provider_migration_followup(p_job_id uuid,p_worker_id uuid,p_attempt integer,p_records jsonb)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; c public.migration_job_chunks; r jsonb; entry uuid; outcome jsonb; message text; si supplier_invoices; source jsonb;
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
              AND COALESCE((other.receipt#>>'{link,sourceVoucher,date}')::date,(other.receipt->'link'->>'invoiceDate')::date) BETWEEN fp.period_start AND fp.period_end)>1 THEN
            RAISE EXCEPTION 'MIGRATION_REGISTRATION_AMBIGUOUS'; END IF;
          IF c.resource='salesInvoices' THEN
            UPDATE invoices SET journal_entry_id=entry WHERE id=c.target_id AND company_id=j.company_id AND journal_entry_id IS NULL;
          ELSIF r#>>'{report,linkType}' IS DISTINCT FROM 'settlement' THEN
            UPDATE supplier_invoices SET registration_journal_entry_id=entry
              WHERE id=c.target_id AND company_id=j.company_id AND registration_journal_entry_id IS NULL;
          END IF;
        END IF;
        IF j.provider='bokio' AND c.resource='supplierInvoices' AND c.receipt#>'{link,bokioSource}' IS NOT NULL THEN
          SELECT * INTO STRICT si FROM supplier_invoices WHERE id=c.target_id AND company_id=j.company_id;
          source:=c.receipt#>'{link,bokioSource}' || jsonb_build_object('supplier_id',si.supplier_id);
          outcome:=complete_bokio_supplier_invoice(j.company_id,j.consent_id,si.id,j.id,source,
            jsonb_build_object('updated_at',si.updated_at,'total',si.total,'supplier_id',si.supplier_id),
            jsonb_build_object('origin','import') || CASE WHEN entry IS NOT NULL AND r#>>'{report,linkType}'='settlement'
              THEN jsonb_build_object('voucher_id',entry,'voucher_kind','cash_purchase') ELSE '{}'::jsonb END,false);
          IF outcome->>'outcome'='concurrent_change' OR (outcome->'settlement' IS NOT NULL AND outcome->'settlement'<>'null'::jsonb
            AND NOT COALESCE((outcome#>>'{settlement,ok}')::boolean,false)
            AND outcome#>>'{settlement,code}'<>'ATTACH_SI_SETTLEMENT_ALREADY_LINKED') THEN
            RAISE EXCEPTION 'MIGRATION_BOKIO_COMPLETION_REJECTED'; END IF;
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


REVOKE ALL ON FUNCTION public.claim_bokio_supplier_completion(uuid,uuid,uuid,boolean,boolean) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.record_bokio_upload(uuid,uuid,text,uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.complete_bokio_supplier_invoice(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.claim_bokio_supplier_completion(uuid,uuid,uuid,boolean,boolean) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.record_bokio_upload(uuid,uuid,text,uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.complete_bokio_supplier_invoice(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,boolean) TO authenticated,service_role;
NOTIFY pgrst,'reload schema';
