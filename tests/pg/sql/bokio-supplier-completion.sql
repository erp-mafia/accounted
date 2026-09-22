-- Synthetic fixtures only. Every write, including posted fixtures, rolls back.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  supplier uuid:=gen_random_uuid(); invoice uuid:=gen_random_uuid(); second_invoice uuid:=gen_random_uuid();
  run uuid:=gen_random_uuid(); other_run uuid:=gen_random_uuid(); fiscal uuid:=gen_random_uuid(); entry uuid:=gen_random_uuid();
  doc uuid:=gen_random_uuid(); s jsonb; expected jsonb; plan jsonb; result jsonb; repeated jsonb; n integer;
  before_ledger jsonb; malformed jsonb; k text; chunk_id uuid; job migration_jobs; worker uuid:=gen_random_uuid(); entry2 uuid:=gen_random_uuid(); source2 jsonb;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (outsider,outsider||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Bokio test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO company_settings(user_id,company_id,accounting_method) VALUES(u,company,'cash');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number,status) VALUES(consent,company,'Bokio test','bokio','556000-0000',1);
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'bokio','not-a-real-token');
  INSERT INTO suppliers(id,user_id,company_id,name,supplier_type) VALUES(supplier,u,company,'Supplier','swedish_business');
  INSERT INTO supplier_invoices(id,user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,received_date,
    status,currency,subtotal,subtotal_sek,vat_amount,vat_amount_sek,total,total_sek,paid_amount,remaining_amount,vat_treatment,paid_at,created_at)
    VALUES(invoice,u,company,supplier,1,'1001','2026-01-02','2026-02-02','2026-01-02','paid','SEK',1250,1250,0,0,1250,1250,1250,0,'standard_25',
      '2026-01-02T00:00:00Z','2026-08-01T00:00:00Z');
  INSERT INTO fiscal_periods(id,user_id,company_id,name,period_start,period_end,is_closed)
    VALUES(fiscal,u,company,'2026','2026-01-01','2026-12-31',false);
  -- Fixtures follow the same draft -> balanced lines -> posted lifecycle as
  -- the shared pg fixture helper. No enforcement trigger is disabled.
  INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status,
    source_voucher_series,source_voucher_number)
    VALUES(entry,u,company,fiscal,1,'A','2026-02-03','Bokio test','manual','draft','V',7);
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order)
    VALUES(entry,'4000',1000,0,'SEK',0),(entry,'2641',250,0,'SEK',1),(entry,'1930',0,1250,'SEK',2);
  UPDATE journal_entries SET status='posted' WHERE id=entry;
  SELECT jsonb_agg(to_jsonb(l)) INTO before_ledger FROM journal_entry_lines l WHERE journal_entry_id=entry;
  INSERT INTO document_attachments(id,company_id,user_id,uploaded_by,storage_path,file_name,sha256_hash,mime_type,upload_source,journal_entry_id)
    VALUES(doc,company,u,u,'test/bokio.pdf','test.pdf',repeat('a',64),'application/pdf','api',entry);
  s:=jsonb_build_object('id','source-1','supplier_id',supplier,'invoice_number','1001','invoice_date','2026-01-02','total',1250,'currency','SEK',
    'is_credit_note',false,'remaining_amount',0,'vat_source','voucher','voucher',jsonb_build_object('series','V','number',7,'date','2026-02-03'),
    'upload_ids',jsonb_build_array('upload-a','upload-b'));
  plan:=jsonb_build_object('header',jsonb_build_object('subtotal',1000,'vat_amount',250),'items',
    '[{"sort_order":0,"description":"Purchase","quantity":1,"unit":"st","unit_price":1000,"line_total":1000,"vat_rate":0.25,"vat_amount":250,"account_number":"4000"}]'::jsonb,
    'voucher_id',entry,'voucher_kind','cash_purchase','clear_fabricated_date',true);
  SELECT jsonb_build_object('updated_at',updated_at,'total',total,'supplier_id',supplier_id) INTO expected FROM supplier_invoices WHERE id=invoice;
  -- Import mode is an authorized provenance follow-up, not a way to submit
  -- header, item or date repairs without the completion lease.
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',u,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',u::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  FOREACH k IN ARRAY ARRAY['header','items','clear_fabricated_date'] LOOP
    malformed:=jsonb_build_object('origin','import',k,plan->k);
    BEGIN
      PERFORM complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,malformed,false);
      RAISE EXCEPTION 'TEST: import mode accepted a repair field: %',k;
    EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BOKIO_IMPORT_PLAN_INVALID' THEN RAISE; END IF; END;
  END LOOP;
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,plan,false);
    RAISE EXCEPTION 'TEST: authenticated repair bypassed the lease';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BOKIO_COMPLETION_LEASE_LOST' THEN RAISE; END IF; END;
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,'{"origin":"import"}',false);
    RAISE EXCEPTION 'TEST: fabricated import accepted an old unmapped invoice';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BOKIO_IMPORT_NOT_FRESH' THEN RAISE; END IF; END;
  RESET ROLE;
  ASSERT NOT EXISTS(SELECT 1 FROM migration_source_records WHERE target_id=invoice),'rejected import wrote provenance';
  ASSERT NOT EXISTS(SELECT 1 FROM processing_history WHERE aggregate_id=invoice),'rejected import wrote history';
  ASSERT NOT EXISTS(SELECT 1 FROM bokio_supplier_completion_work WHERE company_id=company),'rejected import enrolled a company';
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  result:=claim_bokio_supplier_completion(company,consent,run);
  ASSERT result->>'claimed'='false','deployment implicitly enrolled a company';
  result:=complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,plan,true);
  ASSERT result->>'changed'='true' AND result->>'rows'='1','preview missed eligible fields';
  ASSERT (SELECT subtotal=1250 AND paid_at='2026-01-02T00:00:00Z' FROM supplier_invoices WHERE id=invoice),'preview wrote header';
  ASSERT NOT EXISTS(SELECT 1 FROM supplier_invoice_payments WHERE supplier_invoice_id=invoice),'preview wrote payment';
  ASSERT NOT EXISTS(SELECT 1 FROM processing_history WHERE aggregate_id=invoice),'preview wrote history';
  ASSERT NOT EXISTS(SELECT 1 FROM migration_source_records WHERE target_id=invoice),'preview wrote source mapping';
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,plan,false);
    RAISE EXCEPTION 'TEST: missing lease accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BOKIO_COMPLETION_LEASE_LOST' THEN RAISE; END IF; END;
  result:=claim_bokio_supplier_completion(company,consent,run,true);
  ASSERT result->>'claimed'='true','explicit enrollment failed';
  result:=claim_bokio_supplier_completion(company,consent,other_run,true);
  ASSERT result->>'claimed'='false','active lease stolen';
  FOREACH k IN ARRAY ARRAY['description','quantity','unit_price','line_total','vat_amount','vat_rate','account_number','sort_order'] LOOP
    malformed:=jsonb_set(plan,'{items,0}',(plan#>'{items,0}')||jsonb_build_object(k,NULL));
    BEGIN
      PERFORM complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,malformed,false);
      RAISE EXCEPTION 'TEST: null row fact accepted: %',k;
    EXCEPTION WHEN OTHERS THEN IF SQLERRM NOT IN ('BOKIO_ROWS_INVALID','BOKIO_ROWS_MISMATCH') THEN RAISE; END IF; END;
  END LOOP;
  ASSERT NOT EXISTS(SELECT 1 FROM supplier_invoice_items WHERE supplier_invoice_id=invoice),'failed transaction left rows';
  ASSERT NOT EXISTS(SELECT 1 FROM processing_history WHERE aggregate_id=invoice),'failed transaction left history';
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,invoice,run,s-'vat_source',expected,plan,false);
    RAISE EXCEPTION 'TEST: absent VAT provenance accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BOKIO_VAT_NOT_CORROBORATED' THEN RAISE; END IF; END;
  result:=complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected||jsonb_build_object('total',1251),plan,false);
  ASSERT result->>'outcome'='concurrent_change','concurrent edit was overwritten';
  result:=complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,plan,false);
  ASSERT result->>'changed'='true','completion did not write';
  ASSERT (SELECT subtotal=1000 AND vat_amount=250 AND total=1250 AND status='paid' AND registration_journal_entry_id IS NULL
    AND paid_at='2026-02-03T12:00:00Z' AND document_id IS NULL FROM supplier_invoices WHERE id=invoice),'header or paid date incorrect';
  ASSERT (SELECT count(*)=1 FROM supplier_invoice_payments WHERE supplier_invoice_id=invoice AND payment_date='2026-02-03'),'payment date not from voucher';
  ASSERT (SELECT count(*)=1 FROM supplier_invoice_items WHERE supplier_invoice_id=invoice),'rows missing';
  ASSERT (SELECT count(*)=1 FROM processing_history WHERE aggregate_id=invoice AND event_type='SupplierInvoiceCompleted'),'completion event missing';
  repeated:=complete_bokio_supplier_invoice(company,consent,invoice,run,s,expected,plan,false);
  ASSERT repeated=result,'lost acknowledgement did not return saved receipt';
  ASSERT (SELECT count(*)=1 FROM supplier_invoice_items WHERE supplier_invoice_id=invoice),'retry duplicated rows';
  ASSERT (SELECT count(*)=1 FROM processing_history WHERE aggregate_id=invoice AND event_type='SupplierInvoiceCompleted'),'retry duplicated event';
  repeated:=complete_bokio_supplier_invoice(company,consent,NULL,gen_random_uuid(),
    jsonb_build_array(jsonb_build_object('invoice_id',invoice,'source',s)),NULL,'{"origin":"import"}',false);
  ASSERT jsonb_array_length(repeated->'receipts')=1,'wizard batch did not retain source provenance';
  ASSERT (SELECT count(*)=1 FROM processing_history WHERE aggregate_id=invoice AND event_type='SupplierInvoiceCompleted'),'wizard replay duplicated history';
  PERFORM record_bokio_upload(company,consent,'upload-a',doc);
  ASSERT (SELECT document_id IS NULL FROM supplier_invoices WHERE id=invoice),'partial uploads chose a primary document';
  PERFORM record_bokio_upload(company,consent,'upload-b',doc);
  ASSERT (SELECT document_id=doc FROM supplier_invoices WHERE id=invoice),'unique resolved document was not linked';
  SELECT count(*) INTO n FROM processing_history WHERE aggregate_id=invoice;
  PERFORM record_bokio_upload(company,consent,'upload-b',doc);
  ASSERT (SELECT count(*)=n FROM processing_history WHERE aggregate_id=invoice),'upload retry duplicated history';
  ASSERT (SELECT jsonb_agg(to_jsonb(l))=before_ledger FROM journal_entry_lines l WHERE journal_entry_id=entry),'completion changed journal lines';
  ASSERT (SELECT status='posted' FROM journal_entries WHERE id=entry),'completion changed journal status';
  PERFORM claim_bokio_supplier_completion(company,consent,run,false,true);
  result:=claim_bokio_supplier_completion(company,consent,other_run);
  ASSERT result->>'claimed'='true','continuation could not acquire lease';
  SELECT jsonb_build_object('updated_at',updated_at,'total',total,'supplier_id',supplier_id) INTO expected FROM supplier_invoices WHERE id=invoice;
  result:=complete_bokio_supplier_invoice(company,consent,invoice,other_run,s,expected,plan,false);
  ASSERT result->>'changed'='false','second run overwrote populated values';
  ASSERT (SELECT count(*)=n FROM processing_history WHERE aggregate_id=invoice),'second run wrote another event';
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,invoice,other_run,s||jsonb_build_object('supplier_id',outsider),expected,plan,true);
    RAISE EXCEPTION 'TEST: source identity mismatch accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BOKIO_SOURCE_IDENTITY_MISMATCH' THEN RAISE; END IF; END;
  -- The old fabricated signature is cleared independently of VAT/rows.
  INSERT INTO supplier_invoices(id,user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,received_date,
    status,currency,subtotal,total,vat_amount,paid_amount,remaining_amount,paid_at,created_at)
    VALUES(second_invoice,u,company,supplier,2,'1002','2026-01-02','2026-02-02','2026-01-02','paid','SEK',1250,1250,0,1250,0,
      '2026-01-02T00:00:00Z','2026-08-01T00:00:00Z');
  source2:=s||jsonb_build_object('id','source-2','invoice_number','1002','upload_ids','[]'::jsonb);
  SELECT jsonb_build_object('updated_at',updated_at,'total',total,'supplier_id',supplier_id) INTO expected FROM supplier_invoices WHERE id=second_invoice;
  result:=complete_bokio_supplier_invoice(company,consent,second_invoice,other_run,source2,expected,'{"clear_fabricated_date":true}',false);
  ASSERT (SELECT paid_at IS NULL AND status='paid' AND subtotal=1250 FROM supplier_invoices WHERE id=second_invoice),'unknown date repair changed more than the fabricated date';
  -- The durable import follow-up must commit a settlement, never registration.
  INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status,
    source_voucher_series,source_voucher_number)
    VALUES(entry2,u,company,fiscal,2,'A','2026-02-04','Bokio new import','manual','draft','V',8);
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order)
    VALUES(entry2,'4000',1000,0,'SEK',0),(entry2,'2641',250,0,'SEK',1),(entry2,'1930',0,1250,'SEK',2);
  UPDATE journal_entries SET status='posted' WHERE id=entry2;
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  job:=create_provider_migration_job(company,u,consent,ARRAY['supplierInvoices'],NULL);
  job:=claim_provider_migration_job(worker,job.id);
  PERFORM save_provider_migration_page(job.id,worker,job.attempt,'supplierInvoices',1,
    '[{"source_id":"new-import","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO chunk_id FROM migration_job_chunks WHERE job_id=job.id AND source_id='new-import';
  source2:=s||jsonb_build_object('id','new-import','invoice_number','1003','voucher',jsonb_build_object('series','V','number',8,'date','2026-02-04'),'upload_ids','[]'::jsonb);
  PERFORM commit_provider_migration_records(job.id,worker,job.attempt,jsonb_build_array(jsonb_build_object('id',chunk_id,
    'party_source_id','supplier-source','party',jsonb_build_object('name','Supplier'),
    'row',jsonb_build_object('supplier_invoice_number','1003','invoice_date','2026-01-02','due_date','2026-02-02','received_date','2026-01-02',
      'status','paid','currency','SEK','subtotal',1000,'vat_amount',250,'total',1250,'total_sek',1250,'paid_amount',1250,'remaining_amount',0),
    'items','[]'::jsonb,'link',jsonb_build_object('kind','supplier','invoiceDate','2026-01-02','sourceVoucher',source2->'voucher','bokioSource',source2))));
  SELECT target_id INTO second_invoice FROM migration_job_chunks WHERE id=chunk_id;
  ASSERT second_invoice IS NOT NULL,'durable supplier import failed';
  PERFORM advance_provider_migration_job(job.id,worker,job.attempt);
  PERFORM commit_provider_migration_followup(job.id,worker,job.attempt,jsonb_build_array(jsonb_build_object('id',chunk_id,
    'journal_entry_id',entry2,'report',jsonb_build_object('outcome','linked','linkType','settlement'))));
  ASSERT (SELECT state='linked' FROM migration_job_chunks WHERE id=chunk_id),'durable follow-up failed';
  ASSERT (SELECT registration_journal_entry_id IS NULL AND paid_at='2026-02-04T12:00:00Z' FROM supplier_invoices WHERE id=second_invoice),'durable follow-up wrote a false registration';
  ASSERT (SELECT count(*)=1 FROM supplier_invoice_payments WHERE supplier_invoice_id=second_invoice AND journal_entry_id=entry2),'durable follow-up missed payment evidence';
  ASSERT (SELECT count(*)=1 FROM processing_history WHERE aggregate_id=second_invoice AND event_type='SupplierInvoiceCompleted'),'durable evidence provenance missing';
  RESET ROLE;
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  PERFORM set_config('request.jwt.claim.role','authenticated',true);
  SET LOCAL ROLE authenticated;
  ASSERT NOT EXISTS(SELECT 1 FROM bokio_supplier_completion_work WHERE company_id=company),'foreign queue visible';
  ASSERT NOT EXISTS(SELECT 1 FROM bokio_supplier_completion_entries WHERE company_id=company),'foreign receipts visible';
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,invoice,other_run,s,expected,plan,true);
    RAISE EXCEPTION 'TEST: foreign company write accepted';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,invoice,other_run,s,expected,'{"origin":"import"}',false);
    RAISE EXCEPTION 'TEST: import mode bypassed company membership';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  ASSERT NOT has_function_privilege('anon','public.complete_bokio_supplier_invoice(uuid,uuid,uuid,uuid,jsonb,jsonb,jsonb,boolean)','EXECUTE'),'anonymous RPC enabled';
  RESET ROLE;
END $$;
ROLLBACK;
