-- All completion writers share atomic rows and history, including session-based
-- migration wizards. Retain the existing invoice RPC's authorization and locks.
CREATE FUNCTION public.complete_invoice_rows_with_history(
  p_company_id uuid,p_invoice_id uuid,p_rows jsonb,p_header jsonb DEFAULT NULL,p_event jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE
  caller uuid:=auth.uid(); r jsonb; before_split jsonb; after_split jsonb;
  event_uuid uuid; event_actor jsonb; source text; provider_name text; consent_uuid uuid;
BEGIN
  IF COALESCE(auth.role(),'')<>'service_role' AND (
    caller IS NULL OR NOT EXISTS(SELECT 1 FROM company_members
      WHERE company_id=p_company_id AND user_id=caller AND role IN ('owner','admin','member'))
  ) THEN RETURN jsonb_build_object('ok',false,'code','FORBIDDEN'); END IF;
  SELECT jsonb_build_object('subtotal',subtotal,'vat_amount',vat_amount,'vat_rate',vat_rate,'vat_treatment',vat_treatment)
    INTO before_split FROM invoices WHERE id=p_invoice_id AND company_id=p_company_id FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok',false,'code','INVOICE_NOT_FOUND'); END IF;
  r:=complete_invoice_rows(p_company_id,p_invoice_id,p_rows,p_header);
  IF NOT COALESCE((r->>'ok')::boolean,false) OR NOT COALESCE((r->>'wrote')::boolean,false) THEN RETURN r; END IF;

  IF p_event IS NULL OR p_event->>'company_id' IS DISTINCT FROM p_company_id::text
    OR p_event->>'aggregate_id' IS DISTINCT FROM p_invoice_id::text
    OR p_event->>'event_type' IS DISTINCT FROM 'InvoiceRowsCompleted' THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_EVENT_INVALID';
  END IF;
  source:=p_event#>>'{payload,source}'; provider_name:=p_event#>>'{payload,provider}';
  consent_uuid:=(p_event#>>'{payload,consent_id}')::uuid;
  IF COALESCE(source,'') NOT IN ('migration-wizard','complete-invoice-lines')
    OR COALESCE(provider_name,'') NOT IN ('fortnox','visma','briox','bokio','bjornlunden','wint')
    OR NOT EXISTS(SELECT 1 FROM provider_consents WHERE id=consent_uuid AND company_id=p_company_id AND provider=provider_name) THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_EVENT_INVALID';
  END IF;
  -- Session callers cannot forge another actor or append arbitrary PII fields.
  IF COALESCE(auth.role(),'')<>'service_role' THEN
    event_actor:=jsonb_build_object('type','user','id',caller);
  ELSIF p_event#>>'{actor,type}'='user' THEN
    event_actor:=jsonb_build_object('type','user','id',(p_event#>>'{actor,id}')::uuid);
  ELSIF p_event#>>'{actor,type}'='cron' THEN
    event_actor:=jsonb_build_object('type','cron','id','complete-invoice-lines');
  ELSE RAISE EXCEPTION 'INVOICE_COMPLETION_EVENT_INVALID';
  END IF;
  IF COALESCE((r->>'header_updated')::boolean,false) THEN
    SELECT jsonb_build_object('subtotal',subtotal,'vat_amount',vat_amount,'vat_rate',vat_rate,'vat_treatment',vat_treatment)
      INTO after_split FROM invoices WHERE id=p_invoice_id;
  ELSE before_split:=NULL;
  END IF;
  event_uuid:=(p_event->>'event_id')::uuid;
  INSERT INTO processing_history(event_id,company_id,correlation_id,aggregate_type,aggregate_id,event_type,
    payload,payload_schema_version,actor,occurred_at)
  VALUES(event_uuid,p_company_id,(p_event->>'correlation_id')::uuid,'Invoice',p_invoice_id,'InvoiceRowsCompleted',
    jsonb_build_object('source',source,'provider',provider_name,'consent_id',consent_uuid,
      'rows',r->'rows','header_updated',r->'header_updated','header_before',before_split,'header_after',after_split),
    1,event_actor,clock_timestamp());
  RETURN r||jsonb_build_object('event_id',event_uuid);
END $$;
REVOKE ALL ON FUNCTION public.complete_invoice_rows_with_history(uuid,uuid,jsonb,jsonb,jsonb) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.complete_invoice_rows_with_history(uuid,uuid,jsonb,jsonb,jsonb) TO authenticated,service_role;

CREATE OR REPLACE FUNCTION public.finish_invoice_completion(p_company_id uuid,p_worker_id uuid,p_invoice_id uuid,
  p_outcome text,p_rows jsonb DEFAULT NULL,p_header jsonb DEFAULT NULL,p_event jsonb DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER
SET search_path=public SET statement_timeout='8s' SET lock_timeout='1s' AS $$
DECLARE w invoice_completion_work; prior invoice_completion_entries; r jsonb; event_uuid uuid;
BEGIN
  w:=lock_invoice_completion_work(p_company_id,p_worker_id);
  IF NOT EXISTS(SELECT 1 FROM invoices WHERE id=p_invoice_id AND company_id=p_company_id) THEN
    RAISE EXCEPTION 'INVOICE_NOT_FOUND';
  END IF;
  SELECT * INTO prior FROM invoice_completion_entries WHERE company_id=p_company_id AND invoice_id=p_invoice_id;
  IF prior.run_id=p_worker_id AND prior.receipt IS NOT NULL THEN RETURN prior.receipt; END IF;
  IF p_rows IS NOT NULL THEN
    IF p_event->>'correlation_id' IS DISTINCT FROM p_worker_id::text THEN
      RAISE EXCEPTION 'INVOICE_COMPLETION_EVENT_INVALID';
    END IF;
    r:=complete_invoice_rows_with_history(p_company_id,p_invoice_id,p_rows,p_header,p_event);
    IF NOT COALESCE((r->>'ok')::boolean,false) THEN RAISE EXCEPTION 'INVOICE_COMPLETION_WRITE_FAILED: %',r->>'code'; END IF;
    p_outcome:=CASE WHEN (r->>'wrote')::boolean THEN 'written' ELSE 'already_filled' END;
    event_uuid:=(r->>'event_id')::uuid;
  ELSIF p_outcome NOT IN ('unmatched','ambiguous','provider_empty','total_mismatch','rows_mismatch','failed') THEN
    RAISE EXCEPTION 'INVOICE_COMPLETION_OUTCOME_INVALID';
  END IF;
  r:=jsonb_build_object('status',p_outcome,'rows',COALESCE((r->>'rows')::integer,0),
    'headerUpdated',COALESCE((r->>'header_updated')::boolean,false),'eventId',event_uuid);
  INSERT INTO invoice_completion_entries(company_id,invoice_id,next_attempt_at,outcome,run_id,receipt)
    VALUES(p_company_id,p_invoice_id,clock_timestamp()+CASE WHEN p_outcome='failed' THEN interval '1 hour' ELSE interval '1 day' END,
      p_outcome,p_worker_id,r)
    ON CONFLICT(company_id,invoice_id) DO UPDATE SET next_attempt_at=EXCLUDED.next_attempt_at,
      outcome=EXCLUDED.outcome,run_id=EXCLUDED.run_id,receipt=EXCLUDED.receipt;
  RETURN r;
END $$;

NOTIFY pgrst,'reload schema';
