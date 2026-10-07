-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test database (migration 20261005225009).
--
-- crm#1039: the provider import maps a supplier invoice without a number to a
-- NULL supplier_invoice_number (decided 2026-09-23). Before 20261005225009 the
-- column was NOT NULL and every such record ended as needs_attention 23502.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; supplier uuid; sup_row jsonb; party jsonb; rec jsonb; n bigint;
  ch_sup uuid; ch_a uuid; ch_b uuid; ch_c uuid; ch_d uuid; target_a uuid; target_b uuid;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Number-less test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Number-less test','bokio','556000-0002');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'bokio','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  -- The shape entity-mapper.ts mapSupplierInvoice hands the worker: the key is
  -- present and JSON null when the source invoice carries no number.
  sup_row:=jsonb_build_object('supplier_invoice_number',NULL,'invoice_date','2026-09-01','due_date','2026-09-30',
    'currency','SEK','subtotal',1250,'subtotal_sek',1250,'vat_amount',0,'vat_amount_sek',0,'total',1250,'total_sek',1250,
    'vat_treatment','exempt','status','registered','remaining_amount',1250,'is_credit_note',false);
  party:=jsonb_build_object('name','Försäkring AB','org_number','5566778899');

  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"sup-1","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"si-a","payload":"c","payload_hash":"h"},{"source_id":"si-b","payload":"c","payload_hash":"h"},
      {"source_id":"si-c","payload":"c","payload_hash":"h"},{"source_id":"si-d","payload":"c","payload_hash":"h"}]',NULL);
  SELECT id INTO ch_sup FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-1';
  SELECT id INTO ch_a FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-a';
  SELECT id INTO ch_b FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-b';
  SELECT id INTO ch_c FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-c';
  SELECT id INTO ch_d FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-d';

  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_sup,'row',party)));
  SELECT target_id INTO supplier FROM migration_job_chunks WHERE id=ch_sup;
  ASSERT supplier IS NOT NULL,'fixture: supplier was not imported';

  -- 1. A supplier invoice without a number is stored, with a NULL number and
  -- its own arrival number: the record that failed with 23502 (crm#1039).
  rec:=jsonb_build_object('id',ch_a,'party_source_id','sup-1','party',party,'row',sup_row,'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND error_code IS NULL AND (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_a),'number-less supplier invoice was not imported';
  SELECT target_id INTO target_a FROM migration_job_chunks WHERE id=ch_a;
  ASSERT (SELECT supplier_invoice_number IS NULL AND supplier_id=supplier AND arrival_number IS NOT NULL
    FROM supplier_invoices WHERE id=target_a),'number-less invoice was stored with a stand-in number';

  -- 2. A second number-less invoice from the same supplier, same date and
  -- amount (a monthly premium), is its own row: number-less records are
  -- identified by their source record, and NULLs never meet in the index.
  rec:=jsonb_build_object('id',ch_b,'party_source_id','sup-1','party',party,'row',sup_row,'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  SELECT target_id INTO target_b FROM migration_job_chunks WHERE id=ch_b;
  ASSERT (SELECT state='imported' FROM migration_job_chunks WHERE id=ch_b),'second number-less invoice was not imported';
  ASSERT target_b<>target_a,'two number-less source invoices were merged into one row';
  ASSERT (SELECT count(*)=2 FROM migration_source_records WHERE company_id=company AND resource='supplierInvoices'
    AND target_id IN (target_a,target_b)),'number-less invoices are not mapped to their source records';

  -- 3. Committing an imported record again changes nothing.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=2,'a repeated commit inserted the number-less invoice again';

  -- 4. A numbered invoice imports with its number, and another record with
  -- the same number and date but another amount is named, not stored. (The
  -- same number on another date is covered by
  -- provider-migration-reused-supplier-number.sql, 20261006184512.)
  rec:=jsonb_build_object('id',ch_c,'party_source_id','sup-1','party',party,
    'row',sup_row||jsonb_build_object('supplier_invoice_number','AG-1234'),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' FROM migration_job_chunks WHERE id=ch_c),'numbered supplier invoice was not imported';
  rec:=jsonb_build_object('id',ch_d,'party_source_id','sup-1','party',party,
    'row',sup_row||jsonb_build_object('supplier_invoice_number','AG-1234','total',1300,'total_sek',1300,
      'subtotal',1300,'subtotal_sek',1300,'remaining_amount',1300),
    'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_d),'the same supplier number and date is no longer named MIGRATION_INVOICE_NUMBER_TAKEN';
  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=3,'supplier invoices were duplicated or dropped';
  RESET ROLE;
END $$;
SELECT 'supplier invoice number optional assertions passed' AS result;
ROLLBACK;
