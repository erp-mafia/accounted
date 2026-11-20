-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test database (migration 20261012161644).
--
-- crm#1157: Fortnox's löpnummer (GivenNumber, the chunk's source id) has its
-- own column. The import stores it, recognises a stored invoice by it before
-- anything else, takes an invoice imported before the column by the löpnummer
-- in its supplier number on the same supplier and header, and refuses rather
-- than guesses when the header differs.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; supplier uuid; base jsonb; party jsonb; rec jsonb; n bigint;
  first_row uuid; legacy_row uuid; drifted_row uuid; manual_row uuid; claimed_row uuid;
  ch_sup uuid; ch_new uuid; ch_legacy uuid; ch_drifted uuid; ch_manual uuid; ch_claimed uuid;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Fortnox number test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number,status) VALUES(consent,company,'Fortnox number test','fortnox','556000-0004',1);
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'fortnox','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  -- The shape entity-mapper.ts mapSupplierInvoice hands the worker.
  base:=jsonb_build_object('supplier_invoice_number','INV-9001','invoice_date','2026-09-25','due_date','2026-10-25',
    'currency','SEK','subtotal',486.4,'subtotal_sek',486.4,'vat_amount',121.6,'vat_amount_sek',121.6,'total',608,
    'total_sek',608,'vat_treatment','standard_25','status','registered','remaining_amount',608,'is_credit_note',false,
    'payment_reference',NULL);
  party:=jsonb_build_object('name','Frakt AB','org_number','5566778822');

  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"sup-1","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"367","payload":"c","payload_hash":"h"},{"source_id":"55","payload":"c","payload_hash":"h"},{"source_id":"56","payload":"c","payload_hash":"h"},
      {"source_id":"57","payload":"c","payload_hash":"h"},{"source_id":"78","payload":"c","payload_hash":"h"}]',NULL);
  SELECT id INTO ch_sup FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-1';
  SELECT id INTO ch_new FROM migration_job_chunks WHERE job_id=j.id AND source_id='367';
  SELECT id INTO ch_legacy FROM migration_job_chunks WHERE job_id=j.id AND source_id='55';
  SELECT id INTO ch_drifted FROM migration_job_chunks WHERE job_id=j.id AND source_id='56';
  SELECT id INTO ch_manual FROM migration_job_chunks WHERE job_id=j.id AND source_id='57';
  SELECT id INTO ch_claimed FROM migration_job_chunks WHERE job_id=j.id AND source_id='78';

  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_sup,'row',party)));
  SELECT target_id INTO supplier FROM migration_job_chunks WHERE id=ch_sup;
  ASSERT supplier IS NOT NULL,'fixture: supplier was not imported';

  -- 1. A new Fortnox invoice keeps the supplier's number and its löpnummer.
  rec:=jsonb_build_object('id',ch_new,'party_source_id','sup-1','party',party,'row',base,'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  SELECT target_id INTO first_row FROM migration_job_chunks WHERE id=ch_new;
  ASSERT (SELECT supplier_invoice_number='INV-9001' AND fortnox_number='367' FROM supplier_invoices WHERE id=first_row),
    'a new Fortnox invoice did not keep both numbers';

  -- 2. The same record again, with its source map gone and another supplier
  -- number: recognised by the löpnummer alone, never stored twice.
  DELETE FROM migration_source_records WHERE company_id=company AND resource='supplierInvoices' AND source_id='367';
  UPDATE migration_job_chunks SET state='pending',target_id=NULL,receipt='{}'::jsonb WHERE id=ch_new;
  rec:=jsonb_build_object('id',ch_new,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('supplier_invoice_number','INV-9001-B'),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND target_id=first_row AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_new),'a stored löpnummer was not recognised';
  ASSERT EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=company AND resource='supplierInvoices'
    AND source_id='367' AND target_id=first_row),'the recognised invoice did not get its source map back';
  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=1,'the same löpnummer was stored twice';

  -- 3. An invoice imported before the column: the löpnummer is its supplier
  -- number. The same supplier and header is that invoice; it gets the
  -- löpnummer and is not stored again.
  legacy_row:=insert_provider_migration_row('supplier_invoices',base||jsonb_build_object('company_id',company,'user_id',u,
    'supplier_id',supplier,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number','55',
    'invoice_date','2026-08-31','total',212,'total_sek',212,'subtotal',169.6,'subtotal_sek',169.6,
    'vat_amount',42.4,'vat_amount_sek',42.4,'remaining_amount',212));
  rec:=jsonb_build_object('id',ch_legacy,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('supplier_invoice_number','21879901','invoice_date','2026-08-31','total',212,
      'total_sek',212,'subtotal',169.6,'subtotal_sek',169.6,'vat_amount',42.4,'vat_amount_sek',42.4,
      'remaining_amount',212),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND target_id=legacy_row AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_legacy),'an earlier import was not recognised by its löpnummer';
  ASSERT (SELECT fortnox_number='55' AND supplier_invoice_number='55' FROM supplier_invoices WHERE id=legacy_row),
    'the earlier import did not get its löpnummer, or its supplier number changed during the import';

  -- 4. The same supplier and löpnummer on another header: refused, never
  -- guessed and never stored twice.
  drifted_row:=insert_provider_migration_row('supplier_invoices',base||jsonb_build_object('company_id',company,'user_id',u,
    'supplier_id',supplier,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number','56',
    'invoice_date','2026-09-04','total',295,'total_sek',295,'subtotal',236,'subtotal_sek',236,
    'vat_amount',59,'vat_amount_sek',59,'remaining_amount',295));
  rec:=jsonb_build_object('id',ch_drifted,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('supplier_invoice_number','21879902','invoice_date','2026-09-04','total',296,
      'total_sek',296,'subtotal',236.8,'subtotal_sek',236.8,'vat_amount',59.2,'vat_amount_sek',59.2,
      'remaining_amount',296),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_AMBIGUOUS' FROM migration_job_chunks
    WHERE id=ch_drifted),'an earlier import on another header was taken or stored twice';
  ASSERT (SELECT fortnox_number IS NULL FROM supplier_invoices WHERE id=drifted_row),
    'a refused record stamped its löpnummer';

  -- 5. An invoice entered by hand with the supplier's number and the same
  -- header is the Fortnox record: taken, and it gets the löpnummer.
  manual_row:=insert_provider_migration_row('supplier_invoices',base||jsonb_build_object('company_id',company,'user_id',u,
    'supplier_id',supplier,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number','INV-9057',
    'invoice_date','2026-09-18'));
  rec:=jsonb_build_object('id',ch_manual,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('supplier_invoice_number','INV-9057','invoice_date','2026-09-18'),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND target_id=manual_row FROM migration_job_chunks WHERE id=ch_manual),
    'a hand-entered copy of the Fortnox record was not taken';
  ASSERT (SELECT fortnox_number='57' FROM supplier_invoices WHERE id=manual_row),
    'the hand-entered copy did not get its löpnummer';

  -- 6. A stored invoice that carries another löpnummer is another Fortnox
  -- record, even on the same supplier number and header: refused.
  claimed_row:=insert_provider_migration_row('supplier_invoices',base||jsonb_build_object('company_id',company,'user_id',u,
    'supplier_id',supplier,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number','INV-9077',
    'invoice_date','2026-09-20','fortnox_number','77'));
  rec:=jsonb_build_object('id',ch_claimed,'party_source_id','sup-1','party',party,
    'row',base||jsonb_build_object('supplier_invoice_number','INV-9077','invoice_date','2026-09-20'),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_AMBIGUOUS' FROM migration_job_chunks
    WHERE id=ch_claimed),'a record was taken onto an invoice of another löpnummer';
  ASSERT (SELECT fortnox_number='77' FROM supplier_invoices WHERE id=claimed_row),'another record''s löpnummer was replaced';

  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=5,'supplier invoices were duplicated or dropped';

  -- 7. The database itself refuses a second row with the same löpnummer.
  BEGIN
    PERFORM insert_provider_migration_row('supplier_invoices',base||jsonb_build_object('company_id',company,'user_id',u,
      'supplier_id',supplier,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number','OTHER-1',
      'fortnox_number','367'));
    RAISE EXCEPTION 'TEST: a second row with the same löpnummer was stored';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;

  -- 8. A blank löpnummer is refused.
  BEGIN
    UPDATE supplier_invoices SET fortnox_number='  ' WHERE id=drifted_row;
    RAISE EXCEPTION 'TEST: a blank löpnummer was stored';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;
ROLLBACK;
