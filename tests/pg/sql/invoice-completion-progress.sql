-- Run inside a transaction and roll back. All identities are synthetic.
DO $$
DECLARE
  u uuid:=gen_random_uuid(); co uuid:=gen_random_uuid(); co2 uuid:=gen_random_uuid();
  consent uuid:=gen_random_uuid(); consent2 uuid:=gen_random_uuid(); customer uuid:=gen_random_uuid();
  a uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); duplicate_invoice uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); next_worker uuid:=gen_random_uuid();
  other_customer uuid:=gen_random_uuid(); mapped uuid:=gen_random_uuid(); duplicate_key text;
  w public.invoice_completion_work; next_work public.invoice_completion_work;
  candidates jsonb; r jsonb; event jsonb; expected_event_id uuid:=gen_random_uuid(); scan uuid;
  rows jsonb:='[{"description":"Synthetic line","line_total":1000,"vat_rate":25,"vat_amount":250}]';
  excluded uuid[];
BEGIN
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,'completion-'||u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES
    (co,'Synthetic completion A','aktiebolag',u),(co2,'Synthetic completion B','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(co,u,'owner'),(co2,u,'owner');
  INSERT INTO customers(id,user_id,company_id,name,customer_type) VALUES(customer,u,co,'Synthetic customer','swedish_business');
  INSERT INTO provider_consents(id,company_id,name,status,provider,org_number) VALUES
    (consent,co,'Synthetic consent',1,'fortnox','synthetic-a'),(consent2,co2,'Synthetic consent',1,'fortnox','synthetic-b');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES
    (consent,'fortnox','synthetic-token'),(consent2,'fortnox','synthetic-token');
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(a,u,co,customer,'source-a','invoice','2026-09-01','2026-10-01','SEK',1250,0,1250,'standard_25',25,'sent'),
    (b,u,co,customer,'source-b','invoice','2026-09-01','2026-10-01','SEK',1250,0,1250,'standard_25',25,'sent');

  SET LOCAL ROLE service_role;
  PERFORM enqueue_invoice_completion_work();
  ASSERT (SELECT count(*)=1 FROM invoice_completion_work WHERE company_id=co),'enqueue is company-scoped';
  SELECT COALESCE(array_agg(company_id),'{}') INTO excluded FROM invoice_completion_work WHERE company_id<>co;
  w:=claim_invoice_completion_work(worker,excluded); scan:=w.scan_id;
  ASSERT w.company_id=co,'claim eligible company';
  next_work:=claim_invoice_completion_work(next_worker,excluded);
  ASSERT next_work.company_id IS NULL,'a live lease cannot be claimed twice';

  PERFORM save_invoice_completion_page(co,worker,scan,'invoices',1,
    '[{"id":"first","detailId":"first","invoiceNumber":"source-a","issueDate":"2026-09-01","creditNote":false}]',2,'invoices');
  candidates:=load_invoice_completion_candidates(co,worker,false);
  ASSERT candidates->0->'source_ref'='null'::jsonb AND candidates->1->'source_ref'='null'::jsonb,'incomplete scans cannot establish unique matches';
  PERFORM release_invoice_completion_work(co,worker);
  w:=claim_invoice_completion_work(next_worker,excluded);
  ASSERT w.next_page=2 AND w.scan_id=scan,'resume at persisted page';
  BEGIN
    PERFORM save_invoice_completion_page(co,worker,scan,'invoices',2,'[]',NULL,'invoices');
    RAISE EXCEPTION 'stale writer was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%LEASE_LOST%' THEN RAISE; END IF;
  END;
  worker:=next_worker;
  PERFORM save_invoice_completion_page(co,worker,scan,'invoices',2,
    '[{"id":"second","detailId":"second","invoiceNumber":"source-a","issueDate":"2026-09-01","creditNote":false},
      {"id":"source-b-id","detailId":"source-b-id","invoiceNumber":"source-b","issueDate":"2026-09-01","creditNote":false}]',NULL,'invoices');
  candidates:=load_invoice_completion_candidates(co,worker,false);
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) c WHERE c->>'id'=a::text AND (c->>'ambiguous')::boolean),
    'duplicate source keys on different pages are ambiguous';
  ASSERT EXISTS(SELECT 1 FROM jsonb_array_elements(candidates) c WHERE c->>'id'=b::text AND c->'source_ref'->>'id'='source-b-id'),
    'unique source survives a resumed scan';

  r:=finish_invoice_completion(co,worker,a,'ambiguous');
  ASSERT r->>'status'='ambiguous','record non-progress reason';
  ASSERT (SELECT next_attempt_at>now()+interval '23 hours' FROM invoice_completion_entries WHERE company_id=co AND invoice_id=a),
    'unmatchable invoice has an explicit retry schedule';
  candidates:=load_invoice_completion_candidates(co,worker,false);
  ASSERT jsonb_array_length(candidates)=1 AND candidates->0->>'id'=b::text,'non-progress work cannot starve healthy work';

  event:=jsonb_build_object('event_id',expected_event_id,'company_id',co,'aggregate_id',b,'correlation_id',worker,
    'event_type','InvoiceRowsCompleted','occurred_at',now(),'actor',jsonb_build_object('type','cron','id','complete-invoice-lines'),
    'payload',jsonb_build_object('source','complete-invoice-lines','provider','fortnox','consent_id',consent,'rows',1,
      'header_updated',false,'header_before',NULL,'header_after',NULL));
  -- Event failure must roll back the invoice write in the same transaction.
  BEGIN
    PERFORM finish_invoice_completion(co,worker,b,'written',rows,NULL,event||'{"event_type":"invalid"}');
    RAISE EXCEPTION 'invalid history was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%EVENT_INVALID%' THEN RAISE; END IF;
  END;
  ASSERT NOT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=b),'history failure rolled back rows';
  r:=finish_invoice_completion(co,worker,b,'written',rows,NULL,event);
  ASSERT r->>'status'='written','completion wrote rows';
  ASSERT (SELECT count(*)=1 FROM invoice_items WHERE invoice_id=b),'exactly one invoice row';
  ASSERT (SELECT count(*)=1 FROM processing_history WHERE event_id=expected_event_id AND aggregate_id=b),'history was committed';
  ASSERT (SELECT receipt=r FROM invoice_completion_entries WHERE company_id=co AND invoice_id=b),'receipt reconciles a lost HTTP response';
  ASSERT finish_invoice_completion(co,worker,b,'written',rows,NULL,event)=r,'replaying the same operation returns its receipt';
  ASSERT jsonb_array_length(load_invoice_completion_candidates(co,worker,false))=0,'completed rows disappear without offset pagination';
  ASSERT NOT (complete_invoice_rows(co,b,rows,NULL)->>'wrote')::boolean,'wizard after cron remains idempotent';

  -- A row completed by the wizard before the cron is never counted twice.
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(duplicate_invoice,u,co,customer,'wizard-first','invoice','2026-09-01','2026-10-01','SEK',1000,250,1250,'standard_25',25,'sent');
  PERFORM complete_invoice_rows(co,duplicate_invoice,rows,NULL);
  r:=finish_invoice_completion(co,worker,duplicate_invoice,'written',rows,NULL,event);
  ASSERT r->>'status'='already_filled','wizard winner is distinguished from own completion';
  ASSERT (SELECT count(*)=1 FROM invoice_items WHERE invoice_id=duplicate_invoice),'no duplicate rows';

  ASSERT NOT has_function_privilege('authenticated','public.finish_invoice_completion(uuid,uuid,uuid,text,jsonb,jsonb,jsonb)','EXECUTE'),
    'session users cannot bypass the worker';
  ASSERT NOT has_table_privilege('authenticated','public.invoice_completion_entries','INSERT'),
    'users cannot forge matching evidence or receipts';
  BEGIN
    PERFORM finish_invoice_completion(co,worker,gen_random_uuid(),'unmatched');
    RAISE EXCEPTION 'foreign invoice was accepted';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM NOT LIKE '%INVOICE_NOT_FOUND%' THEN RAISE; END IF;
  END;

  -- A trustworthy source identity bypasses the register only within the same
  -- provider, account, resource and company. Multiple identities are not safe.
  INSERT INTO invoices(id,user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(mapped,u,co,customer,'mapped','invoice','2026-09-01','2026-10-01','SEK',1000,250,1250,'standard_25',25,'sent');
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
  VALUES(co,u,'fortnox','wrong-account','salesInvoices','wrong-source',mapped),
    (co2,u,'fortnox','synthetica','salesInvoices','wrong-company',mapped),
    (co,u,'fortnox','synthetica','supplierInvoices','wrong-resource',mapped);
  ASSERT jsonb_array_length(load_invoice_completion_candidates(co,worker,true))=0,'source mapping scope is mandatory';
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
  VALUES(co,u,'fortnox','synthetica','salesInvoices','right-source',mapped);
  candidates:=load_invoice_completion_candidates(co,worker,true);
  ASSERT candidates->0->'source_ref'->>'detailId'='right-source','stable identity enables direct retrieval';
  INSERT INTO migration_source_records(company_id,user_id,provider,account_key,resource,source_id,target_id)
  VALUES(co,u,'fortnox','synthetica','salesInvoices','second-source',mapped);
  ASSERT jsonb_array_length(load_invoice_completion_candidates(co,worker,true))=0,'multiple source identities require discovery';

  -- Candidate batches stay bounded. The existing unique index establishes
  -- local uniqueness across all batches, while provider keys need the scan.
  INSERT INTO invoices(user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  SELECT u,co,customer,'batch-'||n,'invoice','2026-09-01','2026-10-01','SEK',1000,250,1250,'standard_25',25,'sent'
  FROM generate_series(1,30) n;
  candidates:=load_invoice_completion_candidates(co,worker,false);
  ASSERT jsonb_array_length(candidates)=25,'candidate selection is bounded';
  duplicate_key:=candidates->0->>'invoice_number';
  BEGIN
    INSERT INTO invoices(user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
      currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
    VALUES(u,co,customer,duplicate_key,'invoice','2026-09-01','2026-10-01','SEK',1000,250,1250,'standard_25',25,'sent');
    RAISE EXCEPTION 'local duplicate was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- Work released now goes behind an older company, regardless of backlog size.
  INSERT INTO customers(id,user_id,company_id,name,customer_type)
    VALUES(other_customer,u,co2,'Synthetic second customer','swedish_business');
  INSERT INTO invoices(user_id,company_id,customer_id,invoice_number,document_type,invoice_date,due_date,
    currency,subtotal,vat_amount,total,vat_treatment,vat_rate,status)
  VALUES(u,co2,other_customer,'other','invoice','2026-09-01','2026-10-01','SEK',1000,250,1250,'standard_25',25,'sent');
  PERFORM release_invoice_completion_work(co,worker);
  SELECT COALESCE(array_agg(company_id),'{}') INTO excluded FROM invoice_completion_work WHERE company_id NOT IN (co,co2);
  next_work:=claim_invoice_completion_work(gen_random_uuid(),excluded);
  ASSERT next_work.company_id=co2,'a resumed large company does not monopolize the queue';

  -- Clearing operational recovery state never deletes the accounting results
  -- and must not leave child evidence blocking an otherwise permitted cleanup.
  DELETE FROM invoice_completion_work WHERE company_id=co;
  ASSERT NOT EXISTS(SELECT 1 FROM invoice_completion_entries WHERE company_id=co),'recovery entries follow their parent';
  ASSERT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=b),'completed invoice rows survive recovery cleanup';
  ASSERT EXISTS(SELECT 1 FROM processing_history WHERE event_id=expected_event_id),'processing history survives recovery cleanup';

  -- The wizard uses the same atomic write without requiring a cron lease.
  event:=event||jsonb_build_object('aggregate_id',mapped,'payload',
    (event->'payload')||jsonb_build_object('source','migration-wizard','unexpected_private_field','must not be stored'));
  BEGIN
    -- Reusing an existing event UUID forces the history INSERT to fail after
    -- the existing invoice RPC has run. Its rows must roll back too.
    PERFORM complete_invoice_rows_with_history(co,mapped,rows,NULL,event);
    RAISE EXCEPTION 'duplicate history event was accepted';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  ASSERT NOT EXISTS(SELECT 1 FROM invoice_items WHERE invoice_id=mapped),'wizard history failure rolls back invoice rows';

  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',u)::text,true);
  SET LOCAL ROLE authenticated;
  event:=event||jsonb_build_object('event_id',gen_random_uuid());
  r:=complete_invoice_rows_with_history(co,mapped,rows,NULL,event);
  ASSERT (r->>'wrote')::boolean AND r->>'event_id'=event->>'event_id','session wizard completes rows and history together';
  ASSERT (SELECT actor=jsonb_build_object('type','user','id',u) AND NOT payload ? 'unexpected_private_field'
    FROM processing_history WHERE event_id=(event->>'event_id')::uuid),'session actor and allowed payload fields are server controlled';
  ASSERT NOT (complete_invoice_rows_with_history(co,mapped,rows,NULL,event)->>'wrote')::boolean,'wizard retry does not duplicate rows or history';

  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('role','authenticated','sub',current_setting('request.jwt.claim.sub'))::text,true);
  r:=complete_invoice_rows_with_history(co,a,rows,NULL,event);
  ASSERT r->>'code'='FORBIDDEN','atomic history wrapper retains invoice write authorization';
END $$;
