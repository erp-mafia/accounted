BEGIN;
DO $$
DECLARE u uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  company uuid:=gen_random_uuid(); period uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  second_entry uuid:=gen_random_uuid(); job uuid:=gen_random_uuid(); chunk uuid:=gen_random_uuid(); entry uuid:=gen_random_uuid(); rid uuid; replay uuid;
  finding jsonb; before_entries bigint; before_invoices bigint;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (outsider,outsider||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (viewer,viewer||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Historical review test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner'),(company,viewer,'viewer');
  INSERT INTO fiscal_periods(id,company_id,user_id,name,period_start,period_end,is_closed)
    VALUES(period,company,u,'2022','2022-01-01','2022-12-31',false);
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Historical test','bokio','556000-0001');
  INSERT INTO migration_jobs(id,company_id,user_id,consent_id,provider,account_key,resources,state,phase)
    VALUES(job,company,u,consent,'bokio','account',ARRAY['salesInvoices'],'needs_attention','completed');
  INSERT INTO migration_job_chunks(id,job_id,company_id,resource,source_id,resource_order,payload,payload_hash,state,error_code,error_phase)
    VALUES(chunk,job,company,'salesInvoices','source-216',0,'encrypted-fixture','hash','needs_attention','MIGRATION_SOURCE_LINES_MISSING','import');
  INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status)
    VALUES(entry,company,u,period,0,'A','2022-11-07','Faktura #216 betalad av Example AB','manual','draft');
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
    VALUES(entry,'1930',180000,0),(entry,'1510',0,180000);
  PERFORM commit_journal_entry(company,entry);
  finding:=jsonb_build_object('invoiceNumber','216','customer','Example AB','description','Faktura #216 betalad av Example AB',
    'paymentDate','2022-11-07','paymentAmount',180000,'invoiceDate','2022-09-30','sourceId','source-216','chunkId',chunk,
    'payloadHash','hash','origin','incomplete_invoice');
  SELECT count(*) INTO before_entries FROM journal_entries;
  SELECT count(*) INTO before_invoices FROM invoices;
  ASSERT NOT EXISTS(SELECT 1 FROM historical_receivable_references WHERE company_id=company),'proposal saved without approval';
  BEGIN
    PERFORM review_historical_receivable(company,viewer,job,entry,'approved',finding);
    RAISE EXCEPTION 'viewer approved';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN','viewer was not refused'; END;
  BEGIN
    PERFORM review_historical_receivable(company,outsider,job,entry,'approved',finding);
    RAISE EXCEPTION 'outsider approved';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN','foreign caller was not refused'; END;
  BEGIN
    PERFORM review_historical_receivable(company,u,job,entry,'approved',finding||'{"paymentAmount":1}');
    RAISE EXCEPTION 'wrong amount approved';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_REVIEW_CONFLICT','changed evidence was not refused'; END;
  rid:=review_historical_receivable(company,u,job,entry,'approved',finding);
  replay:=review_historical_receivable(company,u,job,entry,'approved',finding);
  ASSERT rid=replay,'approval replay duplicated history';
  ASSERT (SELECT count(*)=1 FROM historical_receivable_references WHERE company_id=company),'history not persisted exactly once';
  ASSERT (SELECT state='skipped' AND receipt->>'reason'='historical_receivable' FROM migration_job_chunks WHERE id=chunk),'source not preserved as historical';
  ASSERT (SELECT count(*)=before_entries FROM journal_entries),'approval created a booking';
  ASSERT (SELECT count(*)=before_invoices FROM invoices),'approval created an invoice';
  -- A reference found only in the ledger preserves unknown original dates.
  INSERT INTO journal_entries(id,company_id,user_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,source_type,status)
    VALUES(second_entry,company,u,period,0,'A','2022-08-01','Kundbet Example AB (215)','manual','draft');
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount)
    VALUES(second_entry,'1930',100,0),(second_entry,'1510',0,100);
  PERFORM commit_journal_entry(company,second_entry);
  SELECT count(*) INTO before_entries FROM journal_entries;
  finding:=jsonb_build_object('invoiceNumber','215','customer','Example AB','description','Kundbet Example AB (215)',
    'paymentDate','2022-08-01','paymentAmount',100,'origin','voucher_only');
  rid:=review_historical_receivable(company,u,job,second_entry,'approved',finding);
  ASSERT (SELECT invoice_date IS NULL AND source_id IS NULL AND origin='voucher_only' FROM historical_receivable_references WHERE id=rid),
    'ledger-only evidence invented original invoice facts';
  ASSERT (SELECT count(*)=before_entries FROM journal_entries),'ledger-only approval created a booking';
  ASSERT (SELECT count(*)=before_invoices FROM invoices),'ledger-only approval created an invoice';
  ASSERT NOT has_function_privilege('authenticated','public.review_historical_receivable(uuid,uuid,uuid,uuid,text,jsonb)','EXECUTE'),'browser can bypass review API';
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',outsider,'role','authenticated')::text,true);
  PERFORM set_config('request.jwt.claim.sub',outsider::text,true);
  SET LOCAL ROLE authenticated;
  ASSERT NOT EXISTS(SELECT 1 FROM historical_receivable_references),'foreign company history leaked';
  RESET ROLE;
  -- The sandbox teardown must release both references before deleting their
  -- payment vouchers, migration job, company and originating user.
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', '', true);
  INSERT INTO company_settings(company_id,user_id,is_sandbox)
    VALUES(company,u,true)
    ON CONFLICT(company_id) DO UPDATE SET is_sandbox=true;
  PERFORM cleanup_sandbox_user(u);
  ASSERT NOT EXISTS(SELECT 1 FROM historical_receivable_references WHERE company_id=company),
    'sandbox history blocked teardown';
  ASSERT NOT EXISTS(SELECT 1 FROM companies WHERE id=company),'sandbox company remains';
  ASSERT NOT EXISTS(SELECT 1 FROM auth.users WHERE id=u),'sandbox user remains';
  ASSERT EXISTS(SELECT 1 FROM auth.users WHERE id=outsider),'unrelated user was deleted';
END $$;
SELECT 'historical receivable review assertions passed';
ROLLBACK;
