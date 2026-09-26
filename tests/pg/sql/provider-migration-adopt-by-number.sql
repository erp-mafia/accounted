-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test database (migration 20260925205556).
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; legacy_customer uuid; other_customer uuid; kept_customer uuid; legacy_supplier uuid;
  inv1 uuid; inv3 uuid; inv5 uuid; dup uuid; dup_party uuid; n bigint; inv_row jsonb; sup_row jsonb; items jsonb; rec jsonb;
  cust1 uuid; cust4 uuid; ch_inv1 uuid; ch_inv2 uuid; ch_inv3 uuid; ch_inv4 uuid; ch_inv5 uuid; ch_inv9 uuid;
  ch_sup uuid; ch_si1 uuid; ch_si2 uuid; ch_si3 uuid;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Adopt test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Adopt test','visma','556000-0001');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'visma','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  inv_row:=jsonb_build_object('document_type','invoice','invoice_date','2026-01-05','due_date','2026-02-05',
    'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
    'vat_treatment','standard_25','vat_rate',25,'status','draft');
  items:='[{"sort_order":1,"description":"Test","quantity":1,"unit_price":100,"line_total":100,"vat_rate":25,"vat_amount":25,"line_type":"product"}]';

  -- Legacy state: an older importer wrote consumers (no org number) and their
  -- invoices without any source receipts.
  legacy_customer:=insert_provider_migration_row('customers',jsonb_build_object('company_id',company,'user_id',u,
    'name','Consumer One','customer_type','individual'));
  other_customer:=insert_provider_migration_row('customers',jsonb_build_object('company_id',company,'user_id',u,
    'name','Consumer Three','customer_type','individual'));
  kept_customer:=insert_provider_migration_row('customers',jsonb_build_object('company_id',company,'user_id',u,
    'name','Consumer Five','customer_type','individual'));
  inv1:=insert_provider_migration_row('invoices',inv_row||jsonb_build_object('company_id',company,'user_id',u,
    'customer_id',legacy_customer,'invoice_number','1001'));
  PERFORM insert_provider_migration_row('invoices',inv_row||jsonb_build_object('company_id',company,'user_id',u,
    'customer_id',legacy_customer,'invoice_number','1002'));
  inv3:=insert_provider_migration_row('invoices',inv_row||jsonb_build_object('company_id',company,'user_id',u,
    'customer_id',other_customer,'invoice_number','1003'));
  inv5:=insert_provider_migration_row('invoices',inv_row||jsonb_build_object('company_id',company,'user_id',u,
    'customer_id',kept_customer,'invoice_number','1005'));
  legacy_supplier:=insert_provider_migration_row('suppliers',jsonb_build_object('company_id',company,'user_id',u,
    'name','Supplier AB','org_number','556677-8899'));
  sup_row:=jsonb_build_object('supplier_invoice_number','S-1','invoice_date','2026-01-05','due_date','2026-02-05',
    'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
    'vat_treatment','standard_25','status','registered','remaining_amount',125,'is_credit_note',false);
  PERFORM insert_provider_migration_row('supplier_invoices',sup_row||jsonb_build_object('company_id',company,'user_id',u,
    'supplier_id',legacy_supplier,'arrival_number',get_next_arrival_number(company)));

  -- The resumable job re-reads every resource.
  j:=create_provider_migration_job(company,u,consent,ARRAY['customers','suppliers','salesInvoices','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'customers',1,
    '[{"source_id":"cust-1","payload":"c","payload_hash":"h"},{"source_id":"cust-4","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"sup-1","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"inv-1","payload":"c","payload_hash":"h"},{"source_id":"inv-2","payload":"c","payload_hash":"h"},
      {"source_id":"inv-3","payload":"c","payload_hash":"h"},{"source_id":"inv-4","payload":"c","payload_hash":"h"},
      {"source_id":"inv-5","payload":"c","payload_hash":"h"},{"source_id":"inv-9","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"si-1","payload":"c","payload_hash":"h"},{"source_id":"si-2","payload":"c","payload_hash":"h"},
      {"source_id":"si-3","payload":"c","payload_hash":"h"}]',NULL);
  SELECT id INTO cust1 FROM migration_job_chunks WHERE job_id=j.id AND source_id='cust-1';
  SELECT id INTO cust4 FROM migration_job_chunks WHERE job_id=j.id AND source_id='cust-4';
  SELECT id INTO ch_sup FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-1';
  SELECT id INTO ch_inv1 FROM migration_job_chunks WHERE job_id=j.id AND source_id='inv-1';
  SELECT id INTO ch_inv2 FROM migration_job_chunks WHERE job_id=j.id AND source_id='inv-2';
  SELECT id INTO ch_inv3 FROM migration_job_chunks WHERE job_id=j.id AND source_id='inv-3';
  SELECT id INTO ch_inv4 FROM migration_job_chunks WHERE job_id=j.id AND source_id='inv-4';
  SELECT id INTO ch_inv5 FROM migration_job_chunks WHERE job_id=j.id AND source_id='inv-5';
  SELECT id INTO ch_inv9 FROM migration_job_chunks WHERE job_id=j.id AND source_id='inv-9';
  SELECT id INTO ch_si1 FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-1';
  SELECT id INTO ch_si2 FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-2';
  SELECT id INTO ch_si3 FROM migration_job_chunks WHERE job_id=j.id AND source_id='si-3';

  -- Customers phase: consumers carry no org number, so the resolver cannot
  -- adopt the legacy rows and creates new ones (unchanged behaviour).
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',cust1,'row',jsonb_build_object('name','Consumer One','customer_type','individual')),
    jsonb_build_object('id',cust4,'row',jsonb_build_object('name','Consumer Five','customer_type','individual')),
    jsonb_build_object('id',ch_sup,'row',jsonb_build_object('name','Supplier AB','org_number','5566778899'))));
  SELECT target_id INTO dup FROM migration_job_chunks WHERE id=cust1;
  ASSERT dup<>legacy_customer,'fixture: resolver adopted a customer without org number';
  SELECT party_id INTO dup_party FROM customers WHERE id=dup;
  ASSERT (SELECT target_id=legacy_supplier FROM migration_job_chunks WHERE id=ch_sup),'fixture: supplier not adopted on org number';

  -- An invoice that exists only in the provider is inserted as before; it
  -- makes the cust-4 duplicate referenced, so that one must never be folded.
  rec:=jsonb_build_object('id',ch_inv9,'party_source_id','cust-4','party',jsonb_build_object('name','Consumer Five'),
    'row',inv_row||jsonb_build_object('invoice_number','1009'),'items',items,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-01-05','totalSek',125));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND (receipt->>'imported')::boolean FROM migration_job_chunks WHERE id=ch_inv9),
    'new provider-only invoice was not inserted';
  ASSERT (SELECT customer_id=(SELECT target_id FROM migration_job_chunks WHERE id=cust4) FROM invoices
    WHERE id=(SELECT target_id FROM migration_job_chunks WHERE id=ch_inv9)),'new invoice lost its resolved customer';

  -- 1. Same number, date, currency and total: adopt the legacy invoice even
  -- though it points at the legacy customer, and fold the duplicate customer.
  rec:=jsonb_build_object('id',ch_inv1,'party_source_id','cust-1','party',jsonb_build_object('name','Consumer One'),
    'row',inv_row||jsonb_build_object('invoice_number','1001'),'items',items,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-01-05','totalSek',125));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND target_id=inv1 AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_inv1),'legacy invoice was not adopted on its own number';
  ASSERT (SELECT customer_id=legacy_customer FROM invoices WHERE id=inv1),'adoption rewrote the legacy customer';
  ASSERT NOT EXISTS(SELECT 1 FROM customers WHERE id=dup),'duplicate customer created by this job survived';
  ASSERT NOT EXISTS(SELECT 1 FROM parties WHERE id=dup_party),'orphan party of the duplicate survived';
  ASSERT (SELECT target_id=legacy_customer FROM migration_source_records WHERE company_id=company
    AND resource='customers' AND source_id='cust-1'),'source customer not mapped to the adopted customer';
  ASSERT (SELECT target_id=legacy_customer FROM migration_job_chunks WHERE id=cust1),'customer receipt still names the duplicate';
  SELECT count(*) INTO n FROM invoice_items WHERE invoice_id=inv1;
  ASSERT n=1,'adopted legacy invoice rows were not completed';
  -- A retry is a no-op.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  SELECT count(*) INTO n FROM invoice_items WHERE invoice_id=inv1;
  ASSERT n=1,'retry duplicated adopted invoice rows';

  -- 2. Same number, different total: never overwritten, a named code instead of 23505.
  rec:=jsonb_build_object('id',ch_inv2,'party_source_id','cust-1','party',jsonb_build_object('name','Consumer One'),
    'row',inv_row||jsonb_build_object('invoice_number','1002','total',999,'total_sek',999),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_inv2),'number collision did not raise MIGRATION_INVOICE_NUMBER_TAKEN';
  ASSERT (SELECT total=125 FROM invoices WHERE company_id=company AND invoice_number='1002'),'collision overwrote the invoice';

  -- 3. A party the job never saw (invoice-scoped id) maps to the adopted
  -- invoice's customer instead of creating a new customer.
  SELECT count(*) INTO n FROM customers WHERE company_id=company;
  rec:=jsonb_build_object('id',ch_inv3,'party_source_id','invoice-party:abc','party',jsonb_build_object('name','Consumer Three'),
    'row',inv_row||jsonb_build_object('invoice_number','1003'),'items',items);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND target_id=inv3 FROM migration_job_chunks WHERE id=ch_inv3),'unmapped-party invoice not adopted';
  ASSERT (SELECT count(*)=n FROM customers WHERE company_id=company),'adopting an invoice created a customer';
  ASSERT (SELECT target_id=other_customer FROM migration_source_records WHERE company_id=company
    AND resource='customers' AND source_id='invoice-party:abc'),'invoice-scoped party not mapped to the adopted customer';

  -- 4. The same legacy invoice claimed by a second source id is ambiguous.
  rec:=jsonb_build_object('id',ch_inv4,'party_source_id','cust-1','party',jsonb_build_object('name','Consumer One'),
    'row',inv_row||jsonb_build_object('invoice_number','1001'),'items',items);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_AMBIGUOUS' FROM migration_job_chunks
    WHERE id=ch_inv4),'second source id silently shared an adopted invoice';

  -- 5. A referenced (non-duplicate) mapping is never folded or deleted; the
  -- adopted invoice keeps its own customer.
  SELECT target_id INTO dup FROM migration_job_chunks WHERE id=cust4;
  rec:=jsonb_build_object('id',ch_inv5,'party_source_id','cust-4','party',jsonb_build_object('name','Consumer Five'),
    'row',inv_row||jsonb_build_object('invoice_number','1005'),'items',items);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND target_id=inv5 FROM migration_job_chunks WHERE id=ch_inv5),'invoice 1005 not adopted';
  ASSERT EXISTS(SELECT 1 FROM customers WHERE id=dup),'referenced customer was deleted';
  ASSERT (SELECT target_id=dup FROM migration_source_records WHERE company_id=company
    AND resource='customers' AND source_id='cust-4'),'referenced mapping was moved';
  ASSERT (SELECT customer_id=kept_customer FROM invoices WHERE id=inv5),'adopted invoice customer changed';
  SELECT count(*) INTO n FROM invoices WHERE company_id=company;
  ASSERT n=5,'sales invoices were duplicated or dropped';

  -- Supplier invoices: numbers are unique per supplier only.
  -- 6. Same supplier and number, same header: adopted (unchanged).
  rec:=jsonb_build_object('id',ch_si1,'party_source_id','sup-1','party',jsonb_build_object('name','Supplier AB','org_number','5566778899'),
    'row',sup_row,'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND NOT (receipt->>'imported')::boolean FROM migration_job_chunks WHERE id=ch_si1),
    'matching supplier invoice not adopted';
  -- 7. Same supplier and number, different total: named code, not 23505.
  rec:=jsonb_build_object('id',ch_si2,'party_source_id','sup-1','party',jsonb_build_object('name','Supplier AB','org_number','5566778899'),
    'row',sup_row||jsonb_build_object('total',999,'total_sek',999,'remaining_amount',999),'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_NUMBER_TAKEN' FROM migration_job_chunks
    WHERE id=ch_si2),'supplier number collision did not raise MIGRATION_INVOICE_NUMBER_TAKEN';
  -- 8. Same number from a different supplier is a different invoice.
  rec:=jsonb_build_object('id',ch_si3,'party_source_id','sup-2','party',jsonb_build_object('name','Other supplier AB','org_number','5561112222'),
    'row',sup_row,'items','[]'::jsonb);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  ASSERT (SELECT state='imported' AND (receipt->>'imported')::boolean FROM migration_job_chunks WHERE id=ch_si3),
    'same number from another supplier was not inserted';
  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=2,'supplier invoices were merged across suppliers or duplicated';

  ASSERT NOT has_function_privilege('authenticated','public.adopt_provider_migration_invoice_party(uuid,text,uuid)','EXECUTE'),
    'client can remap migration parties';
  ASSERT NOT has_function_privilege('authenticated','public.provider_migration_row_referenced(regclass,uuid)','EXECUTE'),
    'client can probe references';
  RESET ROLE;
END $$;
SELECT 'provider migration adopt-by-number assertions passed' AS result;
ROLLBACK;
