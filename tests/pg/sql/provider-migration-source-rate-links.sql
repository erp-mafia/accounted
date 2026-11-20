-- Synthetic fixtures only. Every write, including the posted fixtures, rolls back.
-- crm#1039: a migrated foreign-currency invoice takes the SEK amount its
-- verifikat books, and only once the followup has linked it.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); fiscal uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); j public.migration_jobs;
  e_fx uuid:=gen_random_uuid(); e_sek uuid:=gen_random_uuid(); e_conflict uuid:=gen_random_uuid(); e_credit uuid:=gen_random_uuid();
  ch_fx uuid; ch_sek uuid; ch_gone uuid; ch_conflict uuid; ch_credit uuid;
  inv_fx uuid; inv_sek uuid; inv_gone uuid; inv_conflict uuid; si_credit uuid;
  sales_row jsonb; rec jsonb; rec_fx jsonb; rec_sek jsonb; rec_gone jsonb; rec_conflict jsonb; rec_credit jsonb;
  lines_before jsonb; invoice_before jsonb; credit_before jsonb; n integer;
  -- What a source-rate link may change on the invoice row; everything else stays.
  rated text[]:=ARRAY['journal_entry_id','registration_journal_entry_id','exchange_rate','exchange_rate_date',
    'total_sek','subtotal_sek','vat_amount_sek','updated_at'];
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Source rate test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Source rate test','visma','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'visma','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  INSERT INTO fiscal_periods(id,user_id,company_id,name,period_start,period_end,is_closed)
    VALUES(fiscal,u,company,'2026','2026-01-01','2026-12-31',false);

  -- The verifikat the source booked, as the SIE import brought them in.
  INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status,
    source_voucher_series,source_voucher_number) VALUES
    (e_fx,u,company,fiscal,1,'A','2026-05-04','EUR sale at the source rate','manual','draft','B',501),
    (e_sek,u,company,fiscal,2,'A','2026-05-05','SEK sale','manual','draft','B',502),
    (e_conflict,u,company,fiscal,3,'A','2026-05-05','EUR sale, other amount','manual','draft','B',503),
    (e_credit,u,company,fiscal,4,'A','2026-05-06','EUR supplier credit note','manual','draft','B',504);
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order) VALUES
    (e_fx,'1510',11234.50,0,'SEK',0),(e_fx,'3105',0,11234.50,'SEK',1),
    (e_sek,'1510',125,0,'SEK',0),(e_sek,'3001',0,100,'SEK',1),(e_sek,'2611',0,25,'SEK',2),
    (e_conflict,'1510',1000,0,'SEK',0),(e_conflict,'3105',0,1000,'SEK',1),
    -- A supplier credit note debits 2440.
    (e_credit,'2440',2811.25,0,'SEK',0),(e_credit,'4010',0,2811.25,'SEK',1);
  UPDATE journal_entries SET status='posted' WHERE id IN (e_fx,e_sek,e_conflict,e_credit);
  SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) INTO lines_before FROM journal_entry_lines l
    WHERE l.journal_entry_id IN (e_fx,e_sek,e_conflict,e_credit);

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices','supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"s-fx","payload":"cipher","payload_hash":"hash"},{"source_id":"s-sek","payload":"cipher","payload_hash":"hash"},{"source_id":"s-gone","payload":"cipher","payload_hash":"hash"},{"source_id":"s-conflict","payload":"cipher","payload_hash":"hash"}]',NULL);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"p-credit","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO ch_fx FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-fx';
  SELECT id INTO ch_sek FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-sek';
  SELECT id INTO ch_gone FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-gone';
  SELECT id INTO ch_conflict FROM migration_job_chunks WHERE job_id=j.id AND source_id='s-conflict';
  SELECT id INTO ch_credit FROM migration_job_chunks WHERE job_id=j.id AND source_id='p-credit';

  -- Imported at our own rate: 1 000 EUR at 11.20 is 11 200.00 kr, while the
  -- verifikat books 11 234.50 kr at the source's 11.2345.
  sales_row:=jsonb_build_object('invoice_number','F-1','document_type','invoice','invoice_date','2026-05-04','due_date','2026-06-03',
    'currency','EUR','exchange_rate',11.2,'exchange_rate_date','2026-05-03','subtotal',1000,'subtotal_sek',11200,
    'vat_amount',0,'vat_amount_sek',0,'total',1000,'total_sek',11200,'vat_treatment','export','vat_rate',0,'status','sent');
  rec:=jsonb_build_object('id',ch_fx,'party_source_id','c1','party',jsonb_build_object('name','Customer'),'row',sales_row,
    'items','[{"sort_order":1,"description":"Consulting","quantity":1,"unit_price":1000,"line_total":1000,"vat_rate":0,"vat_amount":0,"line_type":"product"}]'::jsonb,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-04','totalSek',11200,'currencyCode','EUR',
      'sourceVoucher',jsonb_build_object('series','B','number',501)));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    rec,
    rec||jsonb_build_object('id',ch_sek,'row',sales_row||jsonb_build_object('invoice_number','F-2','currency','SEK','exchange_rate',NULL,
        'exchange_rate_date',NULL,'subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
        'vat_treatment','standard_25','vat_rate',25),
      'items','[{"sort_order":1,"description":"Goods","quantity":1,"unit_price":100,"line_total":100,"vat_rate":25,"vat_amount":25,"line_type":"product"}]'::jsonb,
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-05','totalSek',125,'currencyCode','SEK',
        'sourceVoucher',jsonb_build_object('series','B','number',502))),
    rec||jsonb_build_object('id',ch_gone,'row',sales_row||jsonb_build_object('invoice_number','F-3'),
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-04','totalSek',11200,'currencyCode','EUR',
        'sourceVoucher',jsonb_build_object('series','B','number',505))),
    rec||jsonb_build_object('id',ch_conflict,'row',sales_row||jsonb_build_object('invoice_number','F-4','subtotal',90,'subtotal_sek',1008,
        'total',90,'total_sek',1008,'exchange_rate',11.2),
      'items','[{"sort_order":1,"description":"Consulting","quantity":1,"unit_price":90,"line_total":90,"vat_rate":0,"vat_amount":0,"line_type":"product"}]'::jsonb,
      'link',jsonb_build_object('kind','customer','invoiceDate','2026-05-05','totalSek',1008,'currencyCode','EUR',
        'sourceVoucher',jsonb_build_object('series','B','number',503)))));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',ch_credit,
    'party_source_id','supplier-1','party',jsonb_build_object('name','Supplier'),
    'row',jsonb_build_object('supplier_invoice_number','K-1','invoice_date','2026-05-06','due_date','2026-06-05',
      'currency','EUR','exchange_rate',11.3,'exchange_rate_date','2026-05-06','subtotal',250,'subtotal_sek',2825,
      'vat_amount',0,'vat_amount_sek',0,'total',250,'total_sek',2825,'vat_treatment','standard_25','status','credited',
      'remaining_amount',0,'is_credit_note',true),
    'items','[{"sort_order":1,"description":"Refund","quantity":1,"unit_price":250,"line_total":250,"account_number":"4010","vat_rate":0,"vat_amount":0}]'::jsonb,
    'link',jsonb_build_object('kind','supplier','invoiceDate','2026-05-06','totalSek',-2825,'currencyCode','EUR',
      'sourceVoucher',jsonb_build_object('series','B','number',504)))));
  SELECT count(*) INTO n FROM migration_job_chunks WHERE job_id=j.id AND state='imported';
  ASSERT n=5,'fixture records were not imported';
  SELECT target_id INTO inv_fx FROM migration_job_chunks WHERE id=ch_fx;
  SELECT target_id INTO inv_sek FROM migration_job_chunks WHERE id=ch_sek;
  SELECT target_id INTO inv_gone FROM migration_job_chunks WHERE id=ch_gone;
  SELECT target_id INTO inv_conflict FROM migration_job_chunks WHERE id=ch_conflict;
  SELECT target_id INTO si_credit FROM migration_job_chunks WHERE id=ch_credit;
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  ASSERT (SELECT phase='link' FROM migration_jobs WHERE id=j.id),'job did not reach the link phase';

  -- What the worker sends: the linker's report, with the values a
  -- foreign-currency invoice takes from its verifikat.
  rec_fx:=jsonb_build_object('id',ch_fx,'journal_entry_id',e_fx,'report',jsonb_build_object('invoiceId',inv_fx,'kind','customer',
    'outcome','linked','journalEntryId',e_fx,'reason','would link at the source rate (dry run)',
    'sourceRate',jsonb_build_object('total',1000,'totalSek',11234.5,'subtotalSek',11234.5,'vatAmountSek',0,
      'exchangeRate',11.2345,'exchangeRateDate','2026-05-04','previousTotalSek',11200,'previousExchangeRate',11.2)));
  rec_sek:=jsonb_build_object('id',ch_sek,'journal_entry_id',e_sek,'report',jsonb_build_object('invoiceId',inv_sek,'kind','customer',
    'outcome','linked','journalEntryId',e_sek,'reason','would link (dry run)'));
  -- The followup refuses a voucher that is not a posted verifikat of the company.
  rec_gone:=rec_fx||jsonb_build_object('id',ch_gone,'journal_entry_id',gen_random_uuid());
  -- The verifikat books 1 000.00 kr, not the 1 001.00 kr the record claims.
  rec_conflict:=jsonb_build_object('id',ch_conflict,'journal_entry_id',e_conflict,'report',jsonb_build_object('invoiceId',inv_conflict,
    'kind','customer','outcome','linked','journalEntryId',e_conflict,'reason','would link at the source rate (dry run)',
    'sourceRate',jsonb_build_object('total',90,'totalSek',1001,'subtotalSek',1001,'vatAmountSek',0,
      'exchangeRate',11.1222,'exchangeRateDate','2026-05-05','previousTotalSek',1008,'previousExchangeRate',11.2)));
  rec_credit:=jsonb_build_object('id',ch_credit,'journal_entry_id',e_credit,'report',jsonb_build_object('invoiceId',si_credit,
    'kind','supplier','outcome','linked','journalEntryId',e_credit,'reason','would link at the source rate (dry run)',
    'sourceRate',jsonb_build_object('total',250,'totalSek',2811.25,'subtotalSek',2811.25,'vatAmountSek',0,
      'exchangeRate',11.245,'exchangeRateDate','2026-05-06','previousTotalSek',2825,'previousExchangeRate',11.3)));

  -- A stale attempt writes nothing.
  BEGIN
    PERFORM commit_provider_migration_source_rate_links(j.id,worker,j.attempt-1,jsonb_build_array(rec_fx));
    RAISE EXCEPTION 'TEST: stale attempt wrote';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_LEASE_LOST' THEN RAISE; END IF; END;

  -- A value the verifikat does not book rolls the whole batch back, links included.
  BEGIN
    PERFORM commit_provider_migration_source_rate_links(j.id,worker,j.attempt,jsonb_build_array(rec_fx,rec_conflict));
    RAISE EXCEPTION 'TEST: a conflicting source rate was written';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_SOURCE_RATE_CONFLICT' THEN RAISE; END IF; END;
  ASSERT (SELECT journal_entry_id IS NULL AND total_sek=11200 AND exchange_rate=11.2 FROM invoices WHERE id=inv_fx),
    'a refused batch kept a link or an amount';
  ASSERT (SELECT state='imported' FROM migration_job_chunks WHERE id=ch_fx),'a refused batch moved a chunk';

  SELECT to_jsonb(i)-rated INTO invoice_before FROM invoices i WHERE id=inv_fx;
  SELECT to_jsonb(s)-rated INTO credit_before FROM supplier_invoices s WHERE id=si_credit;
  PERFORM commit_provider_migration_source_rate_links(j.id,worker,j.attempt,jsonb_build_array(rec_fx,rec_sek,rec_gone,rec_credit));

  -- The EUR invoice links its verifikat and carries what it books: the
  -- reskontra reads 1 000 x 11.2345 = 11 234.50 kr, the 1510 debit.
  ASSERT (SELECT journal_entry_id=e_fx AND total_sek=11234.50 AND subtotal_sek=11234.50 AND vat_amount_sek=0
      AND exchange_rate=11.2345 AND exchange_rate_date='2026-05-04' FROM invoices WHERE id=inv_fx),
    'the linked EUR invoice did not take the verifikat''s amount';
  ASSERT (SELECT round(total*exchange_rate,2)=11234.50 FROM invoices WHERE id=inv_fx),'the rate does not give the booked amount back';
  ASSERT (SELECT to_jsonb(i)-rated FROM invoices i WHERE id=inv_fx)=invoice_before,
    'the link changed more than the rate, the SEK amounts and the link itself';
  ASSERT (SELECT currency='EUR' AND total=1000 AND status='sent' FROM invoices WHERE id=inv_fx),'fixture invoice changed shape';
  ASSERT (SELECT state='done' AND receipt#>>'{registration,sourceRate,totalSek}'='11234.5' FROM migration_job_chunks WHERE id=ch_fx),
    'the receipt does not keep what the invoice took';
  -- A link without source-rate values is written exactly as before.
  ASSERT (SELECT journal_entry_id=e_sek AND total_sek=125 AND exchange_rate IS NULL FROM invoices WHERE id=inv_sek),
    'a plain link changed the invoice''s amounts';
  -- An invoice the followup refused keeps its own amounts.
  ASSERT (SELECT journal_entry_id IS NULL AND total_sek=11200 AND exchange_rate=11.2 FROM invoices WHERE id=inv_gone),
    'a refused invoice took the verifikat''s amount';
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_VOUCHER_UNAVAILABLE' FROM migration_job_chunks WHERE id=ch_gone),
    'the refused record lost its review outcome';
  -- The supplier credit note debits 2440 and is stored in magnitudes.
  ASSERT (SELECT registration_journal_entry_id=e_credit AND total_sek=2811.25 AND subtotal_sek=2811.25 AND exchange_rate=11.245
      AND total=250 AND is_credit_note FROM supplier_invoices WHERE id=si_credit),
    'the supplier credit note did not take the verifikat''s amount';
  ASSERT (SELECT to_jsonb(s)-rated FROM supplier_invoices s WHERE id=si_credit)=credit_before,
    'the supplier link changed more than the rate, the SEK amounts and the link itself';
  ASSERT (SELECT state='linked' FROM migration_job_chunks WHERE id=ch_credit),'the supplier chunk did not move on';

  -- A replay after a lost response changes nothing.
  PERFORM commit_provider_migration_source_rate_links(j.id,worker,j.attempt,jsonb_build_array(rec_fx,rec_credit));
  ASSERT (SELECT total_sek=11234.50 AND exchange_rate=11.2345 FROM invoices WHERE id=inv_fx),'a replay changed the invoice';

  ASSERT (SELECT jsonb_agg(to_jsonb(l) ORDER BY l.id) FROM journal_entry_lines l
      WHERE l.journal_entry_id IN (e_fx,e_sek,e_conflict,e_credit))=lines_before,'a journal line changed';
  ASSERT (SELECT count(*)=4 FROM journal_entries WHERE company_id=company),'a journal entry was written';
  ASSERT NOT has_function_privilege('authenticated','public.commit_provider_migration_source_rate_links(uuid,uuid,integer,jsonb)','EXECUTE'),
    'a client can write source rates';
  ASSERT NOT has_function_privilege('anon','public.commit_provider_migration_source_rate_links(uuid,uuid,integer,jsonb)','EXECUTE'),
    'anonymous callers can write source rates';
  RESET ROLE;
END $$;
SELECT 'provider migration source-rate link assertions passed' AS result;
ROLLBACK;
