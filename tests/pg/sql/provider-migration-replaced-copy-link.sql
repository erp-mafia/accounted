-- Synthetic fixtures only. Every write, including the posted fixtures, rolls back.
-- Migration 20261009135352: after an SIE re-sync replaced a fiscal year, an
-- invoice that still points at the reversed first copy of its verifikat moves
-- to the live copy, and only when the database proves it is the same source
-- voucher in the same fiscal year.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  fy uuid:=gen_random_uuid(); fy_prev uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid(); j public.migration_jobs;
  imp_prev uuid:=gen_random_uuid(); imp_first uuid:=gen_random_uuid(); imp_second uuid:=gen_random_uuid();
  -- The first import's copies (reversed by the re-sync) and the live copies.
  e_copy uuid:=gen_random_uuid(); e_live uuid:=gen_random_uuid();
  e_copy2 uuid:=gen_random_uuid(); e_live2 uuid:=gen_random_uuid(); e_live3 uuid:=gen_random_uuid();
  e_posted uuid:=gen_random_uuid(); e_live4 uuid:=gen_random_uuid();
  e_prev uuid:=gen_random_uuid(); e_live5 uuid:=gen_random_uuid();
  e_scopy uuid:=gen_random_uuid(); e_slive uuid:=gen_random_uuid();
  originals uuid[]; s uuid; o uuid; n integer:=0;
  ch_move uuid; ch_fresh uuid; ch_other uuid; ch_posted uuid; ch_year uuid; ch_supplier uuid;
  inv_move uuid; inv_fresh uuid; inv_other uuid; inv_posted uuid; inv_year uuid; si uuid;
  sales_row jsonb; rec jsonb; lines_before jsonb; entries_before bigint;
  linked jsonb:=jsonb_build_object('outcome','linked','reason','would link (dry run)');
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Replaced copy test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Replaced copy test','fortnox','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'fortnox','not-a-real-token');
  -- 2025, the first 2026 import, and the re-sync that replaced it.
  INSERT INTO sie_imports(id,company_id,user_id,filename,file_hash,sie_type,status) VALUES
    (imp_prev,company,u,'2025.se',md5('2025'||company::text),4,'completed'),
    (imp_first,company,u,'2026.se',md5('2026a'||company::text),4,'replaced'),
    (imp_second,company,u,'2026.se',md5('2026b'||company::text),4,'completed');
  INSERT INTO fiscal_periods(id,user_id,company_id,name,period_start,period_end,is_closed) VALUES
    (fy_prev,u,company,'2025','2025-01-01','2025-12-31',false),
    (fy,u,company,'2026','2026-01-01','2026-12-31',false);

  -- The verifikat as two SIE imports of the same source year brought them in:
  -- the source ref (B57, B58, D10) is carried by the first copy and again by
  -- the live one. B59 has no copy. B61 also sits on a posted manual entry,
  -- and B62 on a verifikat of the year before.
  INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,
    source_type,status,source_voucher_series,source_voucher_number,import_batch_id,source_ordinal,source_content_hash)
  SELECT e.id,u,company,e.fp,e.no,e.ser,e.d,e.descr,e.st,'draft',e.sser,e.snum,e.batch,e.ord,
    CASE WHEN e.batch IS NULL THEN NULL ELSE encode(sha256(convert_to(e.id::text,'UTF8')),'hex') END
  FROM (VALUES
    (e_copy,fy,1,'B','2026-05-04'::date,'Kundfaktura (2001)','import','B',57,imp_first,0),
    (e_copy2,fy,2,'B','2026-05-05'::date,'Kundfaktura (2002)','import','B',58,imp_first,1),
    (e_scopy,fy,3,'D','2026-05-06'::date,'Levfakt (501)','import','D',10,imp_first,2),
    (e_posted,fy,4,'B','2026-05-08'::date,'Kundfaktura (2004)','manual','B',61,NULL::uuid,NULL::integer),
    (e_live,fy,5,'B','2026-05-04'::date,'Kundfaktura (2001)','import','B',57,imp_second,0),
    (e_live2,fy,6,'B','2026-05-05'::date,'Kundfaktura (2002)','import','B',58,imp_second,1),
    (e_slive,fy,7,'D','2026-05-06'::date,'Levfakt (501)','import','D',10,imp_second,2),
    (e_live3,fy,8,'B','2026-05-07'::date,'Kundfaktura (2003)','import','B',59,imp_second,3),
    (e_live4,fy,9,'B','2026-05-08'::date,'Kundfaktura (2004)','import','B',61,imp_second,4),
    (e_live5,fy,10,'B','2026-05-11'::date,'Kundfaktura (2005)','import','B',62,imp_second,5),
    (e_prev,fy_prev,1,'B','2025-05-12'::date,'Kundfaktura (1501)','import','B',62,imp_prev,0)
  ) AS e(id,fp,no,ser,d,descr,st,sser,snum,batch,ord);
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order)
    SELECT e,'1510',125,0,'SEK',0 FROM unnest(ARRAY[e_copy,e_copy2,e_live,e_live2,e_live3,e_posted,e_live4,e_live5,e_prev]) e
    UNION ALL SELECT e,'3001',0,100,'SEK',1 FROM unnest(ARRAY[e_copy,e_copy2,e_live,e_live2,e_live3,e_posted,e_live4,e_live5,e_prev]) e
    UNION ALL SELECT e,'2611',0,25,'SEK',2 FROM unnest(ARRAY[e_copy,e_copy2,e_live,e_live2,e_live3,e_posted,e_live4,e_live5,e_prev]) e
    UNION ALL SELECT e,'2440',0,125,'SEK',0 FROM unnest(ARRAY[e_scopy,e_slive]) e
    UNION ALL SELECT e,'5010',100,0,'SEK',1 FROM unnest(ARRAY[e_scopy,e_slive]) e
    UNION ALL SELECT e,'2641',25,0,'SEK',2 FROM unnest(ARRAY[e_scopy,e_slive]) e;
  UPDATE journal_entries SET status='posted' WHERE id IN (e_copy,e_copy2,e_scopy,e_posted,e_prev);

  -- The re-sync reverses the first copies: a posted Makulering each, then the
  -- original flipped to reversed, the way undo_sie_import_chunk leaves them,
  -- and only then posts the second import.
  originals:=ARRAY[e_copy,e_copy2,e_scopy,e_prev];
  FOREACH o IN ARRAY originals LOOP
    n:=n+1;
    s:=gen_random_uuid();
    INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,
      source_type,status,reverses_id)
      SELECT s,u,company,fiscal_period_id,100+n,'M',entry_date,'Makulering: '||description,'storno','draft',id
      FROM journal_entries WHERE id=o;
    INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order)
      SELECT s,account_number,credit_amount,debit_amount,currency,sort_order FROM journal_entry_lines WHERE journal_entry_id=o;
    UPDATE journal_entries SET status='posted' WHERE id=s;
    UPDATE journal_entries SET status='reversed',reversed_by_id=s WHERE id=o;
  END LOOP;
  UPDATE journal_entries SET status='posted' WHERE id IN (e_live,e_live2,e_slive,e_live3,e_live4,e_live5);
  SELECT count(*) INTO entries_before FROM journal_entries WHERE company_id=company;
  SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) INTO lines_before FROM journal_entry_lines l
    JOIN journal_entries e ON e.id=l.journal_entry_id WHERE e.company_id=company;

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"s-move","payload":"cipher","payload_hash":"hash"},{"source_id":"s-fresh","payload":"cipher","payload_hash":"hash"},{"source_id":"s-other","payload":"cipher","payload_hash":"hash"},{"source_id":"s-posted","payload":"cipher","payload_hash":"hash"},{"source_id":"s-year","payload":"cipher","payload_hash":"hash"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"p-move","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO ch_move FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-move';
  SELECT id INTO ch_fresh FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-fresh';
  SELECT id INTO ch_other FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-other';
  SELECT id INTO ch_posted FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-posted';
  SELECT id INTO ch_year FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-year';
  SELECT id INTO ch_supplier FROM migration_job_chunks WHERE job_id=j.id AND source_id='p-move';

  sales_row:=jsonb_build_object('invoice_number','F-1','document_type','invoice','invoice_date','2026-05-04','due_date','2026-06-03',
    'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
    'vat_treatment','standard_25','vat_rate',25,'status','sent');
  rec:=jsonb_build_object('id',ch_move,'party_source_id','c1','party',jsonb_build_object('name','Customer'),'row',sales_row,
    'items','[{"sort_order":1,"description":"Goods","quantity":1,"unit_price":100,"line_total":100,"vat_rate":25,"vat_amount":25,"line_type":"product"}]'::jsonb,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-04','totalSek',125,'currencyCode','SEK',
      'sourceVoucher',jsonb_build_object('series','B','number',57)));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    rec,
    rec||jsonb_build_object('id',ch_fresh,'row',sales_row||jsonb_build_object('invoice_number','F-2','invoice_date','2026-05-05'),
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-05','totalSek',125,'currencyCode','SEK',
        'sourceVoucher',jsonb_build_object('series','B','number',58))),
    rec||jsonb_build_object('id',ch_other,'row',sales_row||jsonb_build_object('invoice_number','F-3','invoice_date','2026-05-07'),
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-07','totalSek',125,'currencyCode','SEK',
        'sourceVoucher',jsonb_build_object('series','B','number',59))),
    rec||jsonb_build_object('id',ch_posted,'row',sales_row||jsonb_build_object('invoice_number','F-4','invoice_date','2026-05-08'),
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-08','totalSek',125,'currencyCode','SEK',
        'sourceVoucher',jsonb_build_object('series','B','number',61))),
    rec||jsonb_build_object('id',ch_year,'row',sales_row||jsonb_build_object('invoice_number','F-5','invoice_date','2026-05-11'),
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-11','totalSek',125,'currencyCode','SEK',
        'sourceVoucher',jsonb_build_object('series','B','number',62)))));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',ch_supplier,
    'party_source_id','supplier-1','party',jsonb_build_object('name','Supplier'),
    'row',jsonb_build_object('supplier_invoice_number','501','invoice_date','2026-05-06','due_date','2026-06-05',
      'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
      'vat_treatment','standard_25','status','registered','remaining_amount',125,'is_credit_note',false),
    'items','[{"sort_order":1,"description":"Goods","quantity":1,"unit_price":100,"line_total":100,"account_number":"5010","vat_rate":0.25,"vat_amount":25}]'::jsonb,
    'link',jsonb_build_object('kind','supplier','invoiceDate','2026-05-06','totalSek',125,'currencyCode','SEK',
      'sourceVoucher',jsonb_build_object('series','D','number',10)))));
  ASSERT (SELECT count(*)=6 FROM migration_job_chunks WHERE job_id=j.id AND state='imported'),'fixture records were not imported';
  SELECT target_id INTO inv_move FROM migration_job_chunks WHERE id=ch_move;
  SELECT target_id INTO inv_fresh FROM migration_job_chunks WHERE id=ch_fresh;
  SELECT target_id INTO inv_other FROM migration_job_chunks WHERE id=ch_other;
  SELECT target_id INTO inv_posted FROM migration_job_chunks WHERE id=ch_posted;
  SELECT target_id INTO inv_year FROM migration_job_chunks WHERE id=ch_year;
  SELECT target_id INTO si FROM migration_job_chunks WHERE id=ch_supplier;

  -- What an earlier run left: links to the entries that are now reversed (or,
  -- for F-4, to the other posted entry with the same ref).
  RESET ROLE;
  UPDATE invoices SET journal_entry_id=e_copy WHERE id=inv_move;
  UPDATE invoices SET journal_entry_id=e_copy2 WHERE id=inv_other;
  UPDATE invoices SET journal_entry_id=e_posted WHERE id=inv_posted;
  UPDATE invoices SET journal_entry_id=e_prev WHERE id=inv_year;
  UPDATE supplier_invoices SET registration_journal_entry_id=e_scopy WHERE id=si;
  SET LOCAL ROLE service_role;
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  ASSERT (SELECT phase='link' FROM migration_jobs WHERE id=j.id),'job did not reach the link phase';

  -- A stale attempt writes nothing.
  BEGIN
    PERFORM commit_provider_migration_followup(j.id,worker,j.attempt-1,jsonb_build_array(jsonb_build_object('id',ch_move,
      'journal_entry_id',e_live,'report',linked||jsonb_build_object('journalEntryId',e_live,'replacesJournalEntryId',e_copy))));
    RAISE EXCEPTION 'TEST: stale attempt wrote';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_LEASE_LOST' THEN RAISE; END IF; END;

  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(
    -- The reversed copy of the same source voucher: the link moves.
    jsonb_build_object('id',ch_move,'journal_entry_id',e_live,
      'report',linked||jsonb_build_object('journalEntryId',e_live,'replacesJournalEntryId',e_copy)),
    -- No copy involved: linked from NULL, as before.
    jsonb_build_object('id',ch_fresh,'journal_entry_id',e_live2,'report',linked||jsonb_build_object('journalEntryId',e_live2)),
    -- A reversed entry of ANOTHER source voucher (B58 for a B59 target).
    jsonb_build_object('id',ch_other,'journal_entry_id',e_live3,
      'report',linked||jsonb_build_object('journalEntryId',e_live3,'replacesJournalEntryId',e_copy2)),
    -- A posted entry with the same ref is not a reversed copy.
    jsonb_build_object('id',ch_posted,'journal_entry_id',e_live4,
      'report',linked||jsonb_build_object('journalEntryId',e_live4,'replacesJournalEntryId',e_posted)),
    -- The same ref a year earlier is another verifikat.
    jsonb_build_object('id',ch_year,'journal_entry_id',e_live5,
      'report',linked||jsonb_build_object('journalEntryId',e_live5,'replacesJournalEntryId',e_prev)),
    -- A supplier invoice moves the same way.
    jsonb_build_object('id',ch_supplier,'journal_entry_id',e_slive,
      'report',linked||jsonb_build_object('journalEntryId',e_slive,'replacesJournalEntryId',e_scopy))));

  ASSERT (SELECT journal_entry_id=e_live FROM invoices WHERE id=inv_move),'the link did not move from the reversed copy';
  ASSERT (SELECT state='done' AND receipt#>>'{registration,replacesJournalEntryId}'=e_copy::text FROM migration_job_chunks WHERE id=ch_move),
    'the receipt does not keep which copy the link moved from';
  ASSERT (SELECT journal_entry_id=e_live2 FROM invoices WHERE id=inv_fresh),'a plain link was not written from NULL';
  ASSERT (SELECT state='done' FROM migration_job_chunks WHERE id=ch_fresh),'the plain link did not finish its chunk';
  ASSERT (SELECT journal_entry_id=e_copy2 FROM invoices WHERE id=inv_other),'a link moved to another source voucher';
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_VOUCHER_UNAVAILABLE' FROM migration_job_chunks WHERE id=ch_other),
    'a move to another source voucher was not stopped for review';
  ASSERT (SELECT journal_entry_id=e_posted FROM invoices WHERE id=inv_posted),'a link moved off a posted verifikat';
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_VOUCHER_UNAVAILABLE' FROM migration_job_chunks WHERE id=ch_posted),
    'a move off a posted verifikat was not stopped for review';
  ASSERT (SELECT journal_entry_id=e_prev FROM invoices WHERE id=inv_year),'a link moved across fiscal years';
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_VOUCHER_UNAVAILABLE' FROM migration_job_chunks WHERE id=ch_year),
    'a move across fiscal years was not stopped for review';
  ASSERT (SELECT registration_journal_entry_id=e_slive FROM supplier_invoices WHERE id=si),'the supplier link did not move';
  ASSERT (SELECT state='linked' FROM migration_job_chunks WHERE id=ch_supplier),'the supplier chunk did not move on';

  -- Nothing in the ledger moved: the copies stay reversed, the Makulering
  -- and the live copies stay posted, and no entry or line was written.
  ASSERT (SELECT count(*) FROM journal_entries WHERE company_id=company)=entries_before,'a journal entry was written';
  ASSERT (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM journal_entry_lines l
      JOIN journal_entries e ON e.id=l.journal_entry_id WHERE e.company_id=company)=lines_before,'a journal line changed';
  ASSERT (SELECT bool_and(status='reversed') FROM journal_entries WHERE id IN (e_copy,e_copy2,e_scopy,e_prev)),'a copy changed status';
  ASSERT NOT has_function_privilege('authenticated','public.commit_provider_migration_followup(uuid,uuid,integer,jsonb)','EXECUTE'),
    'a client can commit link outcomes';
  ASSERT NOT has_function_privilege('anon','public.commit_provider_migration_followup(uuid,uuid,integer,jsonb)','EXECUTE'),
    'anonymous callers can commit link outcomes';
  RESET ROLE;
END $$;
SELECT 'provider migration replaced-copy link assertions passed' AS result;
ROLLBACK;
