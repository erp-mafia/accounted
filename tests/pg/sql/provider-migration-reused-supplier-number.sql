-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test database (migration 20261006184512).
--
-- crm#1039: a supplier puts the same reference (an autogiro reference) in the
-- invoice number field of every monthly invoice. The first imports with the
-- number; each later one used to end MIGRATION_INVOICE_NUMBER_TAKEN.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; supplier uuid; base jsonb; party jsonb; rec jsonb; n bigint; feb uuid; mar uuid; jan uuid;
  expected jsonb; src jsonb; result jsonb;
  ch_sup uuid; ch_jan uuid; ch_feb uuid; ch_mar uuid; ch_jan_dup uuid; ch_feb_dup uuid; ch_ocr uuid; ch_same_ref uuid; ch_feb_again uuid;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Reused number test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number,status) VALUES(consent,company,'Reused number test','bokio','556000-0003',1);
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'bokio','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  -- The shape entity-mapper.ts mapSupplierInvoice hands the worker.
  base:=jsonb_build_object('supplier_invoice_number','AG-77','invoice_date','2026-01-28','due_date','2026-02-28',
    'currency','SEK','subtotal',450,'subtotal_sek',450,'vat_amount',0,'vat_amount_sek',0,'total',450,'total_sek',450,
    'vat_treatment','exempt','status','registered','remaining_amount',450,'is_credit_note',false,'payment_reference',NULL);
  party:=jsonb_build_object('name','Försäkring AB','org_number','5566778811');

  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"sup-1","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"si-jan","payload":"c","payload_hash":"h"},{"source_id":"si-feb","payload":"c","payload_hash":"h"},
      {"source_id":"si-mar","payload":"c","payload_hash":"h"},{"source_id":"si-jan-dup","payload":"c","payload_hash":"h"},
      {"source_id":"si-feb-dup","payload":"c","payload_hash":"h"},{"source_id":"si-ocr","payload":"c","payload_hash":"h"},
      {"source_id":"si-same-ref","payload":"c","payload_hash":"h"},{"source_id":"si-feb-again","payload":"c","payload_hash":"h"}]',NULL);
  SELECT id INTO ch_sup FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-1';
  SELECT id INTO ch_jan FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-jan';
  SELECT id INTO ch_feb FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-feb';
  SELECT id INTO ch_mar FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-mar';
  SELECT id INTO ch_jan_dup FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-jan-dup';
  SELECT id INTO ch_feb_dup FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-feb-dup';
  SELECT id INTO ch_ocr FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-ocr';
  SELECT id INTO ch_same_ref FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-same-ref';
  SELECT id INTO ch_feb_again FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-feb-again';

  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_sup,'row',party)));
  SELECT target_id INTO supplier FROM migration_job_chunks WHERE id=ch_sup;
  ASSERT supplier IS NOT NULL,'fixture: supplier was not imported';

  -- 1. The first invoice with the reference keeps it as its number.
  rec:=jsonb_build_object('id',ch_jan,'party_source_id','sup-1','party',party,'row',base,'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  SELECT target_id INTO jan FROM migration_job_chunks WHERE id=ch_jan;
  ASSERT (SELECT supplier_invoice_number='AG-77' AND payment_reference IS NULL FROM supplier_invoices WHERE id=jan),
    'the first invoice lost its number';

  -- 2. Another month: stored without a number, the reference as its
  -- payment_reference, named in the receipt.
  rec:=jsonb_build_object('id',ch_feb,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('invoice_date','2026-02-28','due_date','2026-03-28'),'items','[]'::jsonb,
    'warnings',jsonb_build_object('fxUnresolved',false));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND error_code IS NULL AND (receipt->>'imported')::boolean
    AND (receipt->'warnings'->>'numberAsPaymentReference')::boolean AND receipt->'warnings'->>'fxUnresolved'='false'
    FROM migration_job_chunks WHERE id=ch_feb),'a reused reference on another date was not imported';
  SELECT target_id INTO feb FROM migration_job_chunks WHERE id=ch_feb;
  ASSERT (SELECT supplier_invoice_number IS NULL AND payment_reference='AG-77' AND supplier_id=supplier
    AND arrival_number IS NOT NULL AND invoice_date='2026-02-28' FROM supplier_invoices WHERE id=feb),
    'the reused reference was not kept as payment_reference';

  -- 3. And the month after.
  rec:=jsonb_build_object('id',ch_mar,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('invoice_date','2026-03-28','due_date','2026-04-28'),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  SELECT target_id INTO mar FROM migration_job_chunks WHERE id=ch_mar;
  ASSERT (SELECT supplier_invoice_number IS NULL AND payment_reference='AG-77' FROM supplier_invoices WHERE id=mar)
    AND mar<>feb,'the third month was not stored as its own invoice';

  -- 4. The same reference and date as the first invoice, another amount:
  -- still a duplicate refusal.
  rec:=jsonb_build_object('id',ch_jan_dup,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('total',451,'total_sek',451,'subtotal',451,'subtotal_sek',451,'remaining_amount',451),
    'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_jan_dup),'the same number and date was stored';

  -- 5. The same reference and date as an invoice stored without the number:
  -- also a refusal.
  rec:=jsonb_build_object('id',ch_feb_dup,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('invoice_date','2026-02-28','due_date','2026-03-28','total',451,'total_sek',451,
      'subtotal',451,'subtotal_sek',451,'remaining_amount',451),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_feb_dup),'the same reference and date as a moved invoice was stored';

  -- 6. Another date, but the record carries its own payment reference: storing
  -- both is not possible, so it stays a refusal.
  rec:=jsonb_build_object('id',ch_ocr,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('invoice_date','2026-04-28','due_date','2026-05-28','payment_reference','7350001234'),
    'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_ocr),'a record with its own payment reference lost one of them';

  -- 7. Another date with the reference already as its payment reference: stored.
  rec:=jsonb_build_object('id',ch_same_ref,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('invoice_date','2026-05-28','due_date','2026-06-28','payment_reference','AG-77'),
    'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' FROM migration_job_chunks WHERE id=ch_same_ref),
    'a record whose payment reference is the reused number was refused';
  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=4,'supplier invoices were duplicated or dropped';

  -- 8. A run that has lost its source map adopts the moved invoice on its
  -- header instead of storing it twice.
  DELETE FROM migration_source_records WHERE company_id=company AND resource='supplierInvoices' AND source_id='si-feb';
  rec:=jsonb_build_object('id',ch_feb_again,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('invoice_date','2026-02-28','due_date','2026-03-28'),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND target_id=feb AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_feb_again),'the moved invoice was not adopted without its source map';
  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=4,'a re-run stored the moved invoice twice';

  -- 9. The unique index still guards the real number.
  BEGIN
    PERFORM insert_provider_migration_row('supplier_invoices',base||jsonb_build_object('company_id',company,'user_id',u,
      'supplier_id',supplier,'arrival_number',get_next_arrival_number(company),'invoice_date','2026-06-28'));
    RAISE EXCEPTION 'TEST: a second live invoice with the number was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 10. The Bokio completion pass recognises the moved invoice as its source
  -- (dry run), and still refuses another source number.
  SELECT jsonb_build_object('updated_at',updated_at,'total',total,'supplier_id',supplier_id) INTO expected
    FROM supplier_invoices WHERE id=mar;
  src:=jsonb_build_object('id','si-mar','supplier_id',supplier,'invoice_number','AG-77','invoice_date','2026-03-28',
    'total',450,'currency','SEK','is_credit_note',false);
  result:=complete_bokio_supplier_invoice(company,consent,mar,gen_random_uuid(),src,expected,'{"reason":"unresolved"}',true);
  ASSERT result->>'dry_run'='true','completion did not accept the moved invoice';
  BEGIN
    PERFORM complete_bokio_supplier_invoice(company,consent,mar,gen_random_uuid(),src||jsonb_build_object('invoice_number','AG-78'),
      expected,'{"reason":"unresolved"}',true);
    RAISE EXCEPTION 'TEST: completion accepted another source number';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'BOKIO_SOURCE_IDENTITY_MISMATCH' THEN RAISE; END IF;
  END;
  RESET ROLE;
END $$;
SELECT 'reused supplier number assertions passed' AS result;
ROLLBACK;
