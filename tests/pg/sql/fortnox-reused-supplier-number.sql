-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test database (migration 20261012161644 or later).
--
-- crm#1157 step 2: Fortnox supplier invoices carry the supplier's own number
-- (InvoiceNumber) beside the löpnummer (GivenNumber, the chunk's source id).
-- A supplier that prints one number on invoice after invoice (crm#1039) must
-- not cost an invoice: each Fortnox record is its own row with its own
-- löpnummer, a re-run finds each by it, and what the reused-number rule
-- refuses for every provider is refused here too.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; supplier uuid; base jsonb; party jsonb; n bigint;
  first_row uuid; second_row uuid;
  ch_sup uuid; ch_first uuid; ch_second uuid; ch_same_day uuid; ch_twin uuid; ch_own_ref uuid;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Fortnox reused number test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number,status) VALUES(consent,company,'Fortnox reused number test','fortnox','556000-0004',1);
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'fortnox','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  -- The shape entity-mapper.ts mapSupplierInvoice hands the worker, with the
  -- contract number an insurer prints on every invoice.
  base:=jsonb_build_object('supplier_invoice_number','AVT-1001','invoice_date','2026-08-01','due_date','2026-08-31',
    'currency','SEK','subtotal',800,'subtotal_sek',800,'vat_amount',200,'vat_amount_sek',200,'total',1000,
    'total_sek',1000,'vat_treatment','standard_25','status','registered','remaining_amount',1000,'is_credit_note',false,
    'payment_reference',NULL);
  party:=jsonb_build_object('name','Försäkring AB','org_number','5566778822');

  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"sup-1","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"101","payload":"c","payload_hash":"h"},{"source_id":"102","payload":"c","payload_hash":"h"},
      {"source_id":"103","payload":"c","payload_hash":"h"},{"source_id":"104","payload":"c","payload_hash":"h"},
      {"source_id":"105","payload":"c","payload_hash":"h"}]',NULL);
  SELECT id INTO ch_sup FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-1';
  SELECT id INTO ch_first FROM migration_job_chunks WHERE job_id=j.id AND source_id='101';
  SELECT id INTO ch_second FROM migration_job_chunks WHERE job_id=j.id AND source_id='102';
  SELECT id INTO ch_same_day FROM migration_job_chunks WHERE job_id=j.id AND source_id='103';
  SELECT id INTO ch_own_ref FROM migration_job_chunks WHERE job_id=j.id AND source_id='104';
  SELECT id INTO ch_twin FROM migration_job_chunks WHERE job_id=j.id AND source_id='105';

  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_sup,'row',party)));
  SELECT target_id INTO supplier FROM migration_job_chunks WHERE id=ch_sup;
  ASSERT supplier IS NOT NULL,'fixture: supplier was not imported';

  -- 1. Two Fortnox invoices with the supplier's same number on two dates are
  -- two rows, each with its own löpnummer. The second keeps the number as its
  -- payment reference: only one live invoice per supplier holds a number.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_first,'party_source_id','sup-1','party',party,'row',base,'items','[]'::jsonb),
    jsonb_build_object('id',ch_second,'party_source_id','sup-1','party',party,
      'row',base||jsonb_build_object('invoice_date','2026-09-01','due_date','2026-09-30'),'items','[]'::jsonb)));
  SELECT target_id INTO first_row FROM migration_job_chunks WHERE id=ch_first;
  SELECT target_id INTO second_row FROM migration_job_chunks WHERE id=ch_second;
  ASSERT (SELECT state='imported' FROM migration_job_chunks WHERE id=ch_first),'the first invoice was not imported';
  ASSERT (SELECT state='imported' AND (receipt->'warnings'->>'numberAsPaymentReference')::boolean
    FROM migration_job_chunks WHERE id=ch_second),'the second invoice was not imported with the reused-number warning';
  ASSERT first_row<>second_row,'two Fortnox invoices became one row';
  ASSERT (SELECT supplier_invoice_number='AVT-1001' AND fortnox_number='101' FROM supplier_invoices WHERE id=first_row),
    'the first invoice lost its number or its löpnummer';
  ASSERT (SELECT supplier_invoice_number IS NULL AND payment_reference='AVT-1001' AND fortnox_number='102'
    FROM supplier_invoices WHERE id=second_row),'the second invoice lost the reused number or its löpnummer';

  -- 2. Both again, with their source maps gone: each is found by its
  -- löpnummer, nothing is stored twice and nothing reads as ambiguous.
  DELETE FROM migration_source_records WHERE company_id=company AND resource='supplierInvoices' AND source_id IN ('101','102');
  UPDATE migration_job_chunks SET state='pending',target_id=NULL,receipt='{}'::jsonb WHERE id IN (ch_first,ch_second);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_second,'party_source_id','sup-1','party',party,
      'row',base||jsonb_build_object('invoice_date','2026-09-01','due_date','2026-09-30'),'items','[]'::jsonb),
    jsonb_build_object('id',ch_first,'party_source_id','sup-1','party',party,'row',base,'items','[]'::jsonb)));
  ASSERT (SELECT state='imported' AND target_id=first_row AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_first),'the first invoice was not found again by its löpnummer';
  ASSERT (SELECT state='imported' AND target_id=second_row AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_second),'the second invoice was not found again by its löpnummer';

  -- 3. The same number on the same date as an invoice holding it, for
  -- another amount: refused, as for every provider.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_same_day,'party_source_id','sup-1','party',party,
      'row',base||jsonb_build_object('total',1100,'total_sek',1100,'subtotal',880,'subtotal_sek',880,
        'vat_amount',220,'vat_amount_sek',220,'remaining_amount',1100),'items','[]'::jsonb)));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_same_day),'a second invoice on the same number and date was not refused as a taken number';

  -- 3b. Another löpnummer on the very same number, date and amount (the
  -- invoice registered twice in Fortnox): refused, never folded into the row
  -- of the other löpnummer.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_twin,'party_source_id','sup-1','party',party,'row',base,'items','[]'::jsonb)));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_AMBIGUOUS' FROM migration_job_chunks
    WHERE id=ch_twin),'a second löpnummer was folded into the first one''s row';
  ASSERT (SELECT fortnox_number='101' FROM supplier_invoices WHERE id=first_row),'the first row lost its löpnummer';

  -- 4. The same number on another date, on a record with its own payment
  -- reference: both cannot be kept, refused as for every provider.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_own_ref,'party_source_id','sup-1','party',party,
      'row',base||jsonb_build_object('invoice_date','2026-10-01','due_date','2026-10-31','payment_reference','4455667788'),
      'items','[]'::jsonb)));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_own_ref),'a reused number was dropped to keep another payment reference';

  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=2,'supplier invoices were duplicated or dropped';
END $$;
ROLLBACK;
