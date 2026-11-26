-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test database (migration 20261126190000 or later).
--
-- An import from before fortnox_number (the older /migrate path) holds
-- Fortnox's löpnummer as a supplier invoice's number, on the card that path
-- chose for it: by org number, which folded two Fortnox suppliers of one org
-- number into one card, or by the name the invoice gives. The background
-- import keeps each Fortnox supplier on a card of its own, so it can resolve
-- the record's supplier to another card than the one holding the invoice. The
-- invoice is still that invoice: adopted, never inserted a second time.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; n bigint;
  folded uuid; stub uuid; other uuid; second_card uuid; telecom uuid;
  lease_march uuid; lease_april uuid; credit uuid; other_header uuid; twin_a uuid; twin_b uuid; inserted uuid;
  ch_sup_a uuid; ch_sup_b uuid; ch_sup_t uuid;
  ch_march uuid; ch_april uuid; ch_credit uuid; ch_header uuid; ch_twin uuid;
  lessor jsonb; telco jsonb; base jsonb;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Fortnox invoice on another card test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number,status) VALUES(consent,company,'Fortnox invoice on another card test','fortnox','556000-0004',1);
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'fortnox','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  -- What the older import left, with no source map: one card for a lessor
  -- Fortnox holds twice under one org number, a card named as an invoice
  -- named its supplier, another card, and invoices numbered by löpnummer.
  INSERT INTO suppliers(user_id,company_id,name,org_number) VALUES(u,company,'Leasing AB','5566778822') RETURNING id INTO folded;
  INSERT INTO suppliers(user_id,company_id,name) VALUES(u,company,'Telefoni AB') RETURNING id INTO stub;
  INSERT INTO suppliers(user_id,company_id,name) VALUES(u,company,'Annan Leverantör') RETURNING id INTO other;
  INSERT INTO supplier_invoices(user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,
      currency,subtotal,vat_amount,total,remaining_amount,status)
    VALUES(u,company,folded,get_next_arrival_number(company),'501','2026-03-02','2026-04-01','SEK',1000,250,1250,1250,'overdue')
    RETURNING id INTO lease_march;
  INSERT INTO supplier_invoices(user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,
      currency,subtotal,vat_amount,total,remaining_amount,status)
    VALUES(u,company,folded,get_next_arrival_number(company),'502','2026-04-02','2026-05-02','SEK',1000,250,1250,1250,'overdue')
    RETURNING id INTO lease_april;
  INSERT INTO supplier_invoices(user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,
      currency,subtotal,vat_amount,total,remaining_amount,status,is_credit_note)
    VALUES(u,company,stub,get_next_arrival_number(company),'503','2026-01-10','2026-02-09','SEK',400,100,500,0,'credited',true)
    RETURNING id INTO credit;
  -- The löpnummer of a record below as the number of an invoice of another
  -- header: another invoice, which the record must leave alone.
  INSERT INTO supplier_invoices(user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,
      currency,subtotal,vat_amount,total,remaining_amount,status)
    VALUES(u,company,stub,get_next_arrival_number(company),'601','2026-02-01','2026-03-03','SEK',480,120,600,600,'overdue')
    RETURNING id INTO other_header;
  -- One löpnummer and header on two cards: no telling which one is the record.
  INSERT INTO supplier_invoices(user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,
      currency,subtotal,vat_amount,total,remaining_amount,status)
    VALUES(u,company,stub,get_next_arrival_number(company),'602','2026-05-01','2026-05-31','SEK',800,200,1000,1000,'overdue')
    RETURNING id INTO twin_a;
  INSERT INTO supplier_invoices(user_id,company_id,supplier_id,arrival_number,supplier_invoice_number,invoice_date,due_date,
      currency,subtotal,vat_amount,total,remaining_amount,status)
    VALUES(u,company,other,get_next_arrival_number(company),'602','2026-05-01','2026-05-31','SEK',800,200,1000,1000,'overdue')
    RETURNING id INTO twin_b;

  -- The shape entity-mapper.ts mapSupplierInvoice hands the worker: the
  -- supplier's own number, the löpnummer is the chunk's source id.
  base:=jsonb_build_object('invoice_date','2026-03-02','due_date','2026-04-01','currency','SEK','subtotal',1000,
    'subtotal_sek',1000,'vat_amount',250,'vat_amount_sek',250,'total',1250,'total_sek',1250,
    'vat_treatment','standard_25','status','overdue','remaining_amount',1250,'is_credit_note',false,'payment_reference',NULL);
  lessor:=jsonb_build_object('name','Leasing AB','org_number','5566778822');
  telco:=jsonb_build_object('name','Telefoni Huvudkontor','org_number','5560000001');

  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"sup-a","payload":"c","payload_hash":"h"},{"source_id":"sup-b","payload":"c","payload_hash":"h"},
      {"source_id":"sup-t","payload":"c","payload_hash":"h"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"501","payload":"c","payload_hash":"h"},{"source_id":"502","payload":"c","payload_hash":"h"},
      {"source_id":"503","payload":"c","payload_hash":"h"},{"source_id":"601","payload":"c","payload_hash":"h"},
      {"source_id":"602","payload":"c","payload_hash":"h"}]',NULL);
  SELECT id INTO ch_sup_a FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-a';
  SELECT id INTO ch_sup_b FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-b';
  SELECT id INTO ch_sup_t FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-t';
  SELECT id INTO ch_march FROM migration_job_chunks WHERE job_id=j.id AND source_id='501';
  SELECT id INTO ch_april FROM migration_job_chunks WHERE job_id=j.id AND source_id='502';
  SELECT id INTO ch_credit FROM migration_job_chunks WHERE job_id=j.id AND source_id='503';
  SELECT id INTO ch_header FROM migration_job_chunks WHERE job_id=j.id AND source_id='601';
  SELECT id INTO ch_twin FROM migration_job_chunks WHERE job_id=j.id AND source_id='602';

  -- The first Fortnox supplier of the org number takes the folded card, the
  -- second gets a card of its own, the telecom supplier is new.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_sup_a,'row',lessor),jsonb_build_object('id',ch_sup_b,'row',lessor),
    jsonb_build_object('id',ch_sup_t,'row',telco)));
  ASSERT (SELECT target_id=folded FROM migration_job_chunks WHERE id=ch_sup_a),'fixture: the first lessor did not take the folded card';
  SELECT target_id INTO second_card FROM migration_job_chunks WHERE id=ch_sup_b;
  SELECT target_id INTO telecom FROM migration_job_chunks WHERE id=ch_sup_t;
  ASSERT second_card IS NOT NULL AND second_card<>folded,'fixture: the second lessor did not get a card of its own';
  ASSERT telecom IS NOT NULL AND telecom NOT IN (folded,stub,other),'fixture: the telecom supplier was not new';

  -- 1. Invoices of the second lessor, held on the folded card, and a credit
  -- note held on the card named as the invoice named its supplier: each is
  -- the invoice the company holds, with the löpnummer from now on.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_march,'party_source_id','sup-b','party',lessor,
      'row',base||jsonb_build_object('supplier_invoice_number','LEAS-1'),'items','[]'::jsonb),
    jsonb_build_object('id',ch_april,'party_source_id','sup-b','party',lessor,
      'row',base||jsonb_build_object('supplier_invoice_number','LEAS-2','invoice_date','2026-04-02','due_date','2026-05-02'),
      'items','[]'::jsonb),
    jsonb_build_object('id',ch_credit,'party_source_id','sup-t','party',telco,
      'row',base||jsonb_build_object('supplier_invoice_number','TEL-K1','invoice_date','2026-01-10','due_date','2026-02-09',
        'subtotal',400,'subtotal_sek',400,'vat_amount',100,'vat_amount_sek',100,'total',500,'total_sek',500,
        'status','credited','remaining_amount',0,'is_credit_note',true),'items','[]'::jsonb)));
  ASSERT (SELECT state='imported' AND target_id=lease_march AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_march),'an invoice on the folded card was stored a second time';
  ASSERT (SELECT state='imported' AND target_id=lease_april AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_april),'the next invoice on the folded card was stored a second time';
  ASSERT (SELECT state='imported' AND target_id=credit AND NOT (receipt->>'imported')::boolean
    FROM migration_job_chunks WHERE id=ch_credit),'a credit note on a card of another name was stored a second time';
  ASSERT (SELECT fortnox_number='501' AND supplier_id=folded AND supplier_invoice_number='501' AND total=1250
    FROM supplier_invoices WHERE id=lease_march),'the adopted invoice did not keep its card and header or get its löpnummer';
  ASSERT (SELECT fortnox_number='503' AND supplier_id=stub AND is_credit_note FROM supplier_invoices WHERE id=credit),
    'the adopted credit note did not keep its card or get its löpnummer';
  ASSERT (SELECT target_id=lease_march FROM migration_source_records WHERE company_id=company
    AND resource='supplierInvoices' AND source_id='501'),'the adopted invoice is not the record''s source map';

  -- 2. The löpnummer as the number of an invoice of another header, on
  -- another card: not this record, which is stored as before.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_header,'party_source_id','sup-b','party',lessor,
      'row',base||jsonb_build_object('supplier_invoice_number','LEAS-3','invoice_date','2026-02-15','due_date','2026-03-17'),
      'items','[]'::jsonb)));
  SELECT target_id INTO inserted FROM migration_job_chunks WHERE id=ch_header;
  ASSERT (SELECT state='imported' AND (receipt->>'imported')::boolean FROM migration_job_chunks WHERE id=ch_header),
    'a record whose löpnummer another header holds was not stored';
  ASSERT inserted<>other_header AND (SELECT fortnox_number='601' AND supplier_id=second_card FROM supplier_invoices WHERE id=inserted),
    'the record was not stored on its own card with its löpnummer';
  ASSERT (SELECT fortnox_number IS NULL AND supplier_invoice_number='601' FROM supplier_invoices WHERE id=other_header),
    'the invoice of another header was taken for the record';

  -- 3. Two invoices on two cards that each could be the record: refused,
  -- never chosen between and never stored a third time.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_twin,'party_source_id','sup-b','party',lessor,
      'row',base||jsonb_build_object('supplier_invoice_number','LEAS-4','invoice_date','2026-05-01','due_date','2026-05-31',
        'subtotal',800,'subtotal_sek',800,'vat_amount',200,'vat_amount_sek',200,'total',1000,'total_sek',1000,
        'remaining_amount',1000),'items','[]'::jsonb)));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_INVOICE_AMBIGUOUS' FROM migration_job_chunks WHERE id=ch_twin),
    'a löpnummer two cards hold was not refused';
  ASSERT (SELECT bool_and(fortnox_number IS NULL) FROM supplier_invoices WHERE id IN (twin_a,twin_b)),
    'one of two candidate invoices was taken for the record';

  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=7,'supplier invoices were duplicated or dropped';
END $$;
ROLLBACK;
