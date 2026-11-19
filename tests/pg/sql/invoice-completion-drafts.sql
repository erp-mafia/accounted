-- Synthetic records only. The caller rolls this transaction back.
-- crm#1245: the completion pass fills an imported draft that arrived without
-- rows (a total, no rows), and still leaves an empty in-app draft alone.
DO $$
DECLARE
  u uuid:=gen_random_uuid(); co uuid:=gen_random_uuid(); empty_co uuid:=gen_random_uuid();
  consent uuid:=gen_random_uuid(); empty_consent uuid:=gen_random_uuid();
  customer uuid:=gen_random_uuid(); empty_customer uuid:=gen_random_uuid();
  imported uuid:=gen_random_uuid(); in_app uuid:=gen_random_uuid(); written uuid:=gen_random_uuid();
  empty_only uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); revision uuid; block uuid;
  w invoice_completion_work; excluded uuid[]; candidates jsonb; r jsonb; event jsonb;
  rows jsonb:='[{"sort_order":1,"description":"Synthetic hours","line_total":800,"vat_rate":25,"vat_amount":200},
    {"sort_order":2,"description":"Synthetic travel","line_total":200,"vat_rate":25,"vat_amount":50}]';
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,'drafts-'||u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES
    (co,'Synthetic drafts','aktiebolag',u),(empty_co,'Synthetic empty draft','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(co,u,'owner'),(empty_co,u,'owner');
  INSERT INTO customers(id,user_id,company_id,name,customer_type) VALUES
    (customer,u,co,'Synthetic customer','swedish_business'),(empty_customer,u,empty_co,'Synthetic customer','swedish_business');
  INSERT INTO provider_consents(id,company_id,name,status,provider,org_number) VALUES
    (consent,co,'Synthetic consent',1,'fortnox','synthetic-drafts'),(empty_consent,empty_co,'Synthetic consent',1,'fortnox','synthetic-empty');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES
    (consent,'fortnox','synthetic-token'),(empty_consent,'fortnox','synthetic-token');
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES
    -- Imported from the list form only: a total, no rows, and no VAT rate.
    (imported,u,co,customer,'draft-source','invoice','2026-10-20','2026-11-19','SEK',1250,0,1250,'standard_25',NULL,'draft'),
    -- Begun in Accounted: no rows, so nothing to total.
    (in_app,u,co,customer,NULL,'invoice','2026-10-20','2026-11-19','SEK',0,0,0,'standard_25',25,'draft'),
    -- A draft with rows is complete, whatever its source.
    (written,u,co,customer,'written-source','invoice','2026-10-20','2026-11-19','SEK',1000,250,1250,'standard_25',25,'draft'),
    (empty_only,u,empty_co,empty_customer,NULL,'invoice','2026-10-20','2026-11-19','SEK',0,0,0,'standard_25',25,'draft');
  INSERT INTO invoice_items(invoice_id,sort_order,description,quantity,unit,unit_price,line_total,vat_rate,vat_amount)
    VALUES(written,1,'Synthetic written line',1,'st',1000,1000,25,250);

  SET LOCAL ROLE service_role;
  PERFORM enqueue_invoice_completion_work();
  SELECT COALESCE(array_agg(company_id),'{}') INTO excluded FROM invoice_completion_work WHERE company_id NOT IN (co,empty_co);
  w:=claim_invoice_completion_work(worker,excluded||co);
  ASSERT w.company_id IS NULL,'an empty in-app draft makes no company eligible';
  w:=claim_invoice_completion_work(worker,excluded);
  ASSERT w.company_id=co,'a row-less draft with a total makes its company eligible';

  SELECT credential_revision INTO revision FROM provider_consent_tokens WHERE consent_id=consent;
  ASSERT block_invoice_completion_work(co,worker,consent,revision,'PROVIDER_LICENSE_MISSING'),'record a block';
  ASSERT (invoice_completion_block_status(co)->>'reason')='PROVIDER_LICENSE_MISSING',
    'a block is shown while an imported draft still waits for its rows';
  SELECT block_id INTO block FROM invoice_completion_work WHERE company_id=co;
  ASSERT retry_invoice_completion_work(co,consent,block),'retry clears the block';
  worker:=gen_random_uuid();
  w:=claim_invoice_completion_work(worker,excluded);
  ASSERT w.company_id=co,'the retried company is claimed again';

  PERFORM save_invoice_completion_page(co,worker,w.scan_id,'invoices',w.next_page,
    '[{"id":"src-imported","detailId":"src-imported","invoiceNumber":"draft-source","issueDate":"2026-10-20","creditNote":false},
      {"id":"src-written","detailId":"src-written","invoiceNumber":"written-source","issueDate":"2026-10-20","creditNote":false}]',
    NULL,'invoices');
  ASSERT (SELECT count(*)=1 FROM invoice_completion_entries WHERE company_id=co AND invoice_id=imported),
    'the imported draft is matched to its source';
  ASSERT NOT EXISTS(SELECT 1 FROM invoice_completion_entries WHERE company_id=co AND invoice_id IN (in_app,written)),
    'neither the empty in-app draft nor a draft with rows is matched';
  candidates:=load_invoice_completion_candidates(co,worker,false);
  ASSERT jsonb_array_length(candidates)=1 AND candidates->0->>'id'=imported::text
    AND candidates->0->'source_ref'->>'id'='src-imported','only the imported draft is a candidate, with its source';

  event:=jsonb_build_object('event_id',gen_random_uuid(),'company_id',co,'aggregate_id',imported,'correlation_id',worker,
    'event_type','InvoiceRowsCompleted','occurred_at',now(),'actor',jsonb_build_object('type','cron','id','complete-invoice-lines'),
    'payload',jsonb_build_object('source','complete-invoice-lines','provider','fortnox','consent_id',consent,'rows',2,
      'header_updated',false,'header_before',NULL,'header_after',NULL));
  r:=finish_invoice_completion(co,worker,imported,'written',rows,NULL,event);
  ASSERT r->>'status'='written','the draft got its rows';
  ASSERT (SELECT array_agg(description ORDER BY sort_order)=ARRAY['Synthetic hours','Synthetic travel']
    FROM invoice_items WHERE invoice_id=imported),'rows in the source order';
  ASSERT (SELECT status='draft' AND total=1250 FROM invoices WHERE id=imported),'status and total are never written';
  ASSERT jsonb_array_length(load_invoice_completion_candidates(co,worker,false))=0,'a completed draft leaves the candidates';
  ASSERT (SELECT count(*)=1 FROM invoice_items WHERE invoice_id=written),'the draft with rows is untouched';
  ASSERT NOT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id IN (in_app,empty_only)),'empty drafts stay empty';
END $$;
