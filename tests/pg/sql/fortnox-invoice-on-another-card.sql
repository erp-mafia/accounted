-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test database (migration 20261126190000 or later).
--
-- An import from before fortnox_number (the older /migrate path) holds
-- Fortnox's löpnummer as a supplier invoice's number, on the card that path
-- chose for it: the one with the org number the invoice gives, which folded
-- two Fortnox suppliers of one org number into one card, else the one with the
-- name the invoice gives. The background import keeps each Fortnox supplier on
-- a card of its own, so it can resolve the record's supplier to another card
-- than the one holding the invoice. The invoice is still that invoice: adopted,
-- never inserted a second time. An invoice on a card that path would not have
-- chosen, or two of them, are refused; the resolved card is asked first.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  j public.migration_jobs; n bigint; rec jsonb;
  folded uuid; stub uuid; other uuid; stranger uuid; namesake uuid; second_card uuid; telecom uuid;
  lease_march uuid; lease_april uuid; credit uuid; strangers_own uuid; namesakes uuid; own_first uuid; later_copy uuid;
  number_holder uuid; held_elsewhere uuid;
  ch_sup_a uuid; ch_sup_b uuid; ch_sup_t uuid;
  lessor jsonb; register_telco jsonb; invoice_telco jsonb; base jsonb;
  probe record;
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
  -- named its supplier, and its invoices with the löpnummer as their number.
  -- Beside them, a card of the lessor's name with no org number, and cards
  -- that path would not have chosen for the lessor.
  INSERT INTO suppliers(user_id,company_id,name,org_number) VALUES(u,company,'Leasing AB','5566778822') RETURNING id INTO folded;
  INSERT INTO suppliers(user_id,company_id,name) VALUES(u,company,'Telefoni AB') RETURNING id INTO stub;
  INSERT INTO suppliers(user_id,company_id,name) VALUES(u,company,'Leasing AB') RETURNING id INTO other;
  INSERT INTO suppliers(user_id,company_id,name,org_number) VALUES(u,company,'Byrå AB','5569999990') RETURNING id INTO stranger;
  INSERT INTO suppliers(user_id,company_id,name,org_number) VALUES(u,company,'Leasing AB','5561111110') RETURNING id INTO namesake;

  CREATE TEMP TABLE fixture_invoice(label text PRIMARY KEY, id uuid) ON COMMIT DROP;
  INSERT INTO fixture_invoice
  SELECT f.label, insert_provider_migration_row('supplier_invoices', jsonb_build_object('user_id',u,'company_id',company,
      'supplier_id',f.supplier,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number',f.number,
      'invoice_date',f.day,'due_date',(f.day::date+30)::text,'currency',f.currency,'subtotal',f.total*0.8,'vat_amount',f.total*0.2,
      'total',f.total,'remaining_amount',CASE WHEN f.credit THEN 0 ELSE f.total END,
      'status',CASE WHEN f.credit THEN 'credited' ELSE 'overdue' END,'is_credit_note',f.credit))
  FROM (VALUES
    -- 1. The lessor's invoices on the folded card, a credit note on the card
    -- named as the invoice names its supplier.
    ('lease_march',folded,'501','2026-03-02','SEK',1250,false),
    ('lease_april',folded,'502','2026-04-02','SEK',1250,false),
    ('credit',stub,'503','2026-01-10','SEK',500,true),
    -- 2. The löpnummer on another header, one field at a time.
    ('other_date',stub,'601','2026-02-01','SEK',1250,false),
    ('other_total',stub,'602','2026-03-02','SEK',1300,false),
    ('other_currency',stub,'603','2026-03-02','EUR',1250,false),
    ('other_kind',stub,'604','2026-03-02','SEK',1250,true),
    -- 3. One löpnummer and header on two cards the older path could have
    -- chosen for the lessor's invoice: its org number, and its name.
    ('twin_a',folded,'701','2026-03-02','SEK',1250,false),
    ('twin_b',other,'701','2026-03-02','SEK',1250,false),
    -- 4. Another supplier's own invoice, and a namesake with another org
    -- number: the older path would not have put the lessor's invoice there.
    ('strangers_own',stranger,'702','2026-03-02','SEK',1250,false),
    ('namesakes',namesake,'703','2026-03-02','SEK',1250,false),
    -- 5. On the folded card, beside invoices on the resolved card below.
    ('later_copy',folded,'801','2026-06-01','SEK',1250,false),
    ('held_elsewhere',folded,'802','2026-07-01','SEK',1250,false)
  ) AS f(label,supplier,number,day,currency,total,credit);
  SELECT id INTO lease_march FROM fixture_invoice WHERE label='lease_march';
  SELECT id INTO lease_april FROM fixture_invoice WHERE label='lease_april';
  SELECT id INTO credit FROM fixture_invoice WHERE label='credit';
  SELECT id INTO strangers_own FROM fixture_invoice WHERE label='strangers_own';
  SELECT id INTO namesakes FROM fixture_invoice WHERE label='namesakes';
  SELECT id INTO later_copy FROM fixture_invoice WHERE label='later_copy';
  SELECT id INTO held_elsewhere FROM fixture_invoice WHERE label='held_elsewhere';

  -- The shape entity-mapper.ts mapSupplierInvoice hands the worker: the
  -- supplier's own number, the löpnummer is the chunk's source id, and the
  -- party is the supplier as the invoice gives it.
  base:=jsonb_build_object('invoice_date','2026-03-02','due_date','2026-04-01','currency','SEK','subtotal',1000,
    'subtotal_sek',1000,'vat_amount',250,'vat_amount_sek',250,'total',1250,'total_sek',1250,
    'vat_treatment','standard_25','status','overdue','remaining_amount',1250,'is_credit_note',false,'payment_reference',NULL);
  lessor:=jsonb_build_object('name','Leasing AB','org_number','5566778822');
  register_telco:=jsonb_build_object('name','Telefoni Huvudkontor','org_number','5560000001');
  invoice_telco:=jsonb_build_object('name','Telefoni AB','org_number',NULL);

  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"sup-a","payload":"c","payload_hash":"h"},{"source_id":"sup-b","payload":"c","payload_hash":"h"},
      {"source_id":"sup-t","payload":"c","payload_hash":"h"}]',NULL);
  SELECT jsonb_agg(jsonb_build_object('source_id',s,'payload','c','payload_hash','h')) INTO rec
    FROM unnest(ARRAY['501','502','503','601','602','603','604','701','702','703','801','802']) AS s;
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,rec,NULL);
  SELECT id INTO ch_sup_a FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-a';
  SELECT id INTO ch_sup_b FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-b';
  SELECT id INTO ch_sup_t FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-t';

  -- The first Fortnox supplier of the org number takes the folded card, the
  -- second gets a card of its own, the telecom supplier is new.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_sup_a,'row',lessor),jsonb_build_object('id',ch_sup_b,'row',lessor),
    jsonb_build_object('id',ch_sup_t,'row',register_telco)));
  ASSERT (SELECT target_id=folded FROM migration_job_chunks WHERE id=ch_sup_a),'fixture: the first lessor did not take the folded card';
  SELECT target_id INTO second_card FROM migration_job_chunks WHERE id=ch_sup_b;
  SELECT target_id INTO telecom FROM migration_job_chunks WHERE id=ch_sup_t;
  ASSERT second_card IS NOT NULL AND second_card NOT IN (folded,namesake),'fixture: the second lessor did not get a card of its own';
  ASSERT telecom IS NOT NULL AND telecom NOT IN (folded,stub,other,stranger,namesake),'fixture: the telecom supplier was not new';

  -- On the resolved card: the record of 801 under the supplier's own number,
  -- and the supplier's number of 802 on the same date for another amount.
  SELECT insert_provider_migration_row('supplier_invoices', jsonb_build_object('user_id',u,'company_id',company,
      'supplier_id',second_card,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number','LEAS-21',
      'invoice_date','2026-06-01','due_date','2026-07-01','currency','SEK','subtotal',1000,'vat_amount',250,'total',1250,
      'remaining_amount',1250,'status','overdue')) INTO own_first;
  SELECT insert_provider_migration_row('supplier_invoices', jsonb_build_object('user_id',u,'company_id',company,
      'supplier_id',second_card,'arrival_number',get_next_arrival_number(company),'supplier_invoice_number','LEAS-22',
      'invoice_date','2026-07-01','due_date','2026-07-31','currency','SEK','subtotal',799.2,'vat_amount',199.8,'total',999,
      'remaining_amount',999,'status','overdue')) INTO number_holder;

  CREATE TEMP TABLE fixture_record(source text PRIMARY KEY, party_source text, party jsonb, overrides jsonb) ON COMMIT DROP;
  INSERT INTO fixture_record VALUES
    ('501','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-1')),
    ('502','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-2','invoice_date','2026-04-02','due_date','2026-05-02')),
    ('503','sup-t',invoice_telco,jsonb_build_object('supplier_invoice_number','TEL-K1','invoice_date','2026-01-10',
      'due_date','2026-02-09','subtotal',400,'subtotal_sek',400,'vat_amount',100,'vat_amount_sek',100,'total',500,
      'total_sek',500,'status','credited','remaining_amount',0,'is_credit_note',true)),
    ('601','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-11')),
    ('602','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-12')),
    ('603','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-13')),
    ('604','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-14')),
    ('701','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-15')),
    ('702','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-16')),
    ('703','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-17')),
    ('801','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-21','invoice_date','2026-06-01','due_date','2026-07-01')),
    ('802','sup-b',lessor,jsonb_build_object('supplier_invoice_number','LEAS-22','invoice_date','2026-07-01','due_date','2026-07-31'));
  FOR probe IN SELECT * FROM fixture_record ORDER BY source LOOP
    PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object(
      'id',(SELECT id FROM migration_job_chunks WHERE job_id=j.id AND source_id=probe.source),
      'party_source_id',probe.party_source,'party',probe.party,'row',base||probe.overrides,'items','[]'::jsonb)));
  END LOOP;
  CREATE TEMP TABLE outcome ON COMMIT DROP AS
    SELECT c.source_id AS source, c.state, c.error_code, c.target_id, (c.receipt->>'imported')::boolean AS imported
    FROM migration_job_chunks c WHERE c.job_id=j.id AND c.resource='supplierInvoices';

  -- 1. The invoices the company holds, on the folded card and on the card
  -- named as the invoice named its supplier: adopted, with the löpnummer and
  -- the source map from now on, each on its own card and header.
  ASSERT (SELECT state='imported' AND target_id=lease_march AND NOT imported FROM outcome WHERE source='501'),
    'an invoice on the folded card was stored a second time';
  ASSERT (SELECT state='imported' AND target_id=lease_april AND NOT imported FROM outcome WHERE source='502'),
    'the next invoice on the folded card was stored a second time';
  ASSERT (SELECT state='imported' AND target_id=credit AND NOT imported FROM outcome WHERE source='503'),
    'a credit note on the card named as the invoice names its supplier was stored a second time';
  ASSERT (SELECT fortnox_number='501' AND supplier_id=folded AND supplier_invoice_number='501' AND total=1250
    FROM supplier_invoices WHERE id=lease_march),'the adopted invoice did not keep its card and header or get its löpnummer';
  ASSERT (SELECT fortnox_number='503' AND supplier_id=stub AND is_credit_note FROM supplier_invoices WHERE id=credit),
    'the adopted credit note did not keep its card or get its löpnummer';
  ASSERT (SELECT target_id=lease_march FROM migration_source_records WHERE company_id=company
    AND resource='supplierInvoices' AND source_id='501'),'the adopted invoice is not the record''s source map';

  -- 2. The löpnummer on another date, total, currency or kind: another
  -- invoice, left alone, and the record is stored on its own card.
  ASSERT (SELECT bool_and(state='imported' AND imported) FROM outcome WHERE source IN ('601','602','603','604')),
    'a record whose löpnummer another header holds was not stored';
  ASSERT (SELECT count(*)=4 FROM supplier_invoices WHERE company_id=company AND supplier_id=second_card
    AND fortnox_number IN ('601','602','603','604')),'the records were not stored on their own card with their löpnummer';
  ASSERT (SELECT bool_and(fortnox_number IS NULL) FROM supplier_invoices
    WHERE id IN (SELECT id FROM fixture_invoice WHERE label LIKE 'other\_%')),'an invoice of another header was taken for a record';

  -- 3. and 4. Two candidates, another supplier's own invoice and a namesake's
  -- with another org number: refused for a person, nothing written to them
  -- and nothing stored a second time.
  ASSERT (SELECT bool_and(state='needs_attention' AND error_code='MIGRATION_INVOICE_AMBIGUOUS') FROM outcome
    WHERE source IN ('701','702','703')),'a löpnummer held where the older import would not have put the record was not refused';
  ASSERT (SELECT bool_and(fortnox_number IS NULL) FROM supplier_invoices
    WHERE id IN (SELECT id FROM fixture_invoice WHERE label IN ('twin_a','twin_b','strangers_own','namesakes'))),
    'an invoice on a card the older import would not have chosen was taken for a record';
  ASSERT NOT EXISTS(SELECT 1 FROM migration_source_records WHERE company_id=company AND resource='supplierInvoices'
    AND source_id IN ('701','702','703')),'a refused record got a source map';

  -- 5. The resolved card is asked first: its invoice under the supplier's own
  -- number is the record, and the copy on the folded card is left alone. Where
  -- it holds only the supplier's number on another amount, the record found
  -- on the folded card is adopted, not refused as a taken number.
  ASSERT (SELECT state='imported' AND target_id=own_first AND NOT imported FROM outcome WHERE source='801'),
    'the invoice on the resolved card was passed over for a copy on another card';
  ASSERT (SELECT fortnox_number IS NULL FROM supplier_invoices WHERE id=later_copy),'the copy on the folded card was taken';
  ASSERT (SELECT state='imported' AND target_id=held_elsewhere AND NOT imported FROM outcome WHERE source='802'),
    'the record held on the folded card was not adopted beside a taken number';
  ASSERT (SELECT fortnox_number IS NULL AND total=999 FROM supplier_invoices WHERE id=number_holder),
    'the invoice holding the supplier''s number was changed';

  SELECT count(*) INTO n FROM supplier_invoices WHERE company_id=company;
  ASSERT n=19,'supplier invoices were duplicated or dropped';
END $$;
ROLLBACK;
