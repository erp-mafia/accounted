-- Synthetic fixtures only. Every write, including the posted fixtures, rolls back.
-- Migration 20261011135841: an invoice with a verifikat is never a draft. The
-- import's link write marks a draft sent when it links the verifikat the
-- source booked it with, and the CHECK refuses every other way to reach a
-- draft that holds a verifikat.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  fy uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid(); j public.migration_jobs; imp uuid:=gen_random_uuid();
  e_draft uuid:=gen_random_uuid(); e_sent uuid:=gen_random_uuid(); e_spare uuid:=gen_random_uuid();
  ch_draft uuid; ch_sent uuid; ch_plain uuid; inv_draft uuid; inv_sent uuid; inv_plain uuid;
  sales_row jsonb; rec jsonb; entries_before bigint;
  linked jsonb:=jsonb_build_object('outcome','linked','reason','would link (dry run)');
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Draft verifikat test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Draft verifikat test','visma','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'visma','not-a-real-token');
  INSERT INTO sie_imports(id,company_id,user_id,filename,file_hash,sie_type,status) VALUES
    (imp,company,u,'2026.se',md5('2026'||company::text),4,'completed');
  INSERT INTO fiscal_periods(id,user_id,company_id,name,period_start,period_end,is_closed) VALUES
    (fy,u,company,'2026','2026-01-01','2026-12-31',false);

  -- The source's booking verifikat for each invoice: Dr 1510 125, Cr 3001 100, Cr 2611 25.
  INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,
    source_type,status,source_voucher_series,source_voucher_number,import_batch_id,source_ordinal,source_content_hash)
  SELECT e.id,u,company,fy,e.no,'B',e.d,e.descr,'import','draft','B',e.snum,imp,e.ord,encode(sha256(convert_to(e.id::text,'UTF8')),'hex')
  FROM (VALUES
    (e_draft,1,'2026-05-04'::date,'Kundfaktura (2001)',57,0),
    (e_sent,2,'2026-05-05'::date,'Kundfaktura (2002)',58,1),
    (e_spare,3,'2026-05-06'::date,'Kundfaktura (2003)',59,2)
  ) AS e(id,no,d,descr,snum,ord);
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order)
    SELECT e,'1510',125,0,'SEK',0 FROM unnest(ARRAY[e_draft,e_sent,e_spare]) e
    UNION ALL SELECT e,'3001',0,100,'SEK',1 FROM unnest(ARRAY[e_draft,e_sent,e_spare]) e
    UNION ALL SELECT e,'2611',0,25,'SEK',2 FROM unnest(ARRAY[e_draft,e_sent,e_spare]) e;
  UPDATE journal_entries SET status='posted' WHERE id IN (e_draft,e_sent,e_spare);
  SELECT count(*) INTO entries_before FROM journal_entries WHERE company_id=company;

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"s-draft","payload":"cipher","payload_hash":"hash"},{"source_id":"s-sent","payload":"cipher","payload_hash":"hash"},{"source_id":"s-plain","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO ch_draft FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-draft';
  SELECT id INTO ch_sent FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-sent';
  SELECT id INTO ch_plain FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-plain';

  -- F-1 arrives as a draft although the source booked it (the Visma mapper's
  -- old fallback), F-2 as sent, F-3 as a draft with no voucher at the source.
  sales_row:=jsonb_build_object('invoice_number','F-1','document_type','invoice','invoice_date','2026-05-04','due_date','2026-06-03',
    'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
    'vat_treatment','standard_25','vat_rate',25,'status','draft');
  rec:=jsonb_build_object('id',ch_draft,'party_source_id','c1','party',jsonb_build_object('name','Customer'),'row',sales_row,
    'items','[{"sort_order":1,"description":"Goods","quantity":1,"unit_price":100,"line_total":100,"vat_rate":25,"vat_amount":25,"line_type":"product"}]'::jsonb,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-04','totalSek',125,'currencyCode','SEK',
      'sourceVoucher',jsonb_build_object('series','B','number',57)));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    rec,
    rec||jsonb_build_object('id',ch_sent,'row',sales_row||jsonb_build_object('invoice_number','F-2','invoice_date','2026-05-05','status','sent'),
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-05','totalSek',125,'currencyCode','SEK',
        'sourceVoucher',jsonb_build_object('series','B','number',58))),
    rec||jsonb_build_object('id',ch_plain,'row',sales_row||jsonb_build_object('invoice_number','F-3','invoice_date','2026-05-06'),
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-06','totalSek',125,'currencyCode','SEK'))));
  ASSERT (SELECT count(*)=3 FROM migration_job_chunks WHERE job_id=j.id AND state='imported'),'fixture records were not imported';
  SELECT target_id INTO inv_draft FROM migration_job_chunks WHERE id=ch_draft;
  SELECT target_id INTO inv_sent FROM migration_job_chunks WHERE id=ch_sent;
  SELECT target_id INTO inv_plain FROM migration_job_chunks WHERE id=ch_plain;
  ASSERT (SELECT status='draft' AND journal_entry_id IS NULL FROM invoices WHERE id=inv_draft),'F-1 was not imported as an unlinked draft';

  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  ASSERT (SELECT phase='link' FROM migration_jobs WHERE id=j.id),'job did not reach the link phase';
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch_draft,'journal_entry_id',e_draft,'report',linked||jsonb_build_object('journalEntryId',e_draft)),
    jsonb_build_object('id',ch_sent,'journal_entry_id',e_sent,'report',linked||jsonb_build_object('journalEntryId',e_sent)),
    jsonb_build_object('id',ch_plain,'report',jsonb_build_object('outcome','noRef','reason','the provider named no voucher'))));

  -- The draft the source booked is linked and issued in one write.
  ASSERT (SELECT status='sent' AND journal_entry_id=e_draft FROM invoices WHERE id=inv_draft),
    'the linked draft was not marked sent';
  ASSERT (SELECT state='done' FROM migration_job_chunks WHERE id=ch_draft),'the draft chunk did not finish';
  -- An issued invoice links as before and keeps its status.
  ASSERT (SELECT status='sent' AND journal_entry_id=e_sent FROM invoices WHERE id=inv_sent),'the sent invoice did not link';
  ASSERT (SELECT state='done' FROM migration_job_chunks WHERE id=ch_sent),'the sent chunk did not finish';
  -- A draft without a source voucher stays a draft.
  ASSERT (SELECT status='draft' AND journal_entry_id IS NULL FROM invoices WHERE id=inv_plain),'an unlinked draft changed';
  RESET ROLE;

  -- The CHECK: no write reaches a draft that holds a verifikat.
  BEGIN
    UPDATE invoices SET journal_entry_id=e_spare WHERE id=inv_plain;
    RAISE EXCEPTION 'TEST: a draft took a verifikat';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE invoices SET status='draft' WHERE id=inv_sent;
    RAISE EXCEPTION 'TEST: an invoice with a verifikat went back to draft';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO invoices(user_id,company_id,customer_id,invoice_number,invoice_date,due_date,status,currency,
      subtotal,vat_amount,total,journal_entry_id)
      SELECT u,company,customer_id,'F-4','2026-05-06','2026-06-05','draft','SEK',100,25,125,e_spare FROM invoices WHERE id=inv_plain;
    RAISE EXCEPTION 'TEST: a draft was inserted with a verifikat';
  EXCEPTION WHEN check_violation THEN NULL; END;
  -- Issuing first and linking after, the order every in-app path keeps, holds.
  UPDATE invoices SET status='sent' WHERE id=inv_plain;
  UPDATE invoices SET journal_entry_id=e_spare WHERE id=inv_plain;

  ASSERT (SELECT count(*) FROM journal_entries WHERE company_id=company)=entries_before,'a journal entry was written';
  ASSERT NOT EXISTS(SELECT 1 FROM invoices WHERE status='draft' AND journal_entry_id IS NOT NULL),
    'a draft with a verifikat exists';
END $$;
SELECT 'invoice draft has no verifikat assertions passed' AS result;
ROLLBACK;
