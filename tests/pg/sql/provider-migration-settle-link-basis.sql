-- Synthetic fixtures only. Every write, including the posted fixtures, rolls back.
-- Migration 20261101045830: the settle phase links the pair the reconcile phase
-- planned through link_supplier_invoice_to_voucher, and the payment row names
-- the rule that chose it, not a person.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  fy uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid(); j public.migration_jobs; imp uuid:=gen_random_uuid();
  payment uuid:=gen_random_uuid(); ch uuid; inv uuid;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Settle basis test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO company_settings(user_id,company_id,accounting_method) VALUES(u,company,'accrual');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Settle basis test','visma','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'visma','not-a-real-token');
  INSERT INTO sie_imports(id,company_id,user_id,filename,file_hash,sie_type,status) VALUES
    (imp,company,u,'2026.se',md5('2026'||company::text),4,'completed');
  INSERT INTO fiscal_periods(id,user_id,company_id,name,period_start,period_end,is_closed) VALUES
    (fy,u,company,'2026','2026-01-01','2026-12-31',false);

  -- The source's payment verifikat: Dr 2440 125, Cr 1930 125.
  INSERT INTO journal_entries(id,user_id,company_id,fiscal_period_id,voucher_number,voucher_series,entry_date,description,
    source_type,status,source_voucher_series,source_voucher_number,import_batch_id,source_ordinal,source_content_hash)
  VALUES(payment,u,company,fy,1,'B','2026-02-05','Utbetalning leverantör','import','draft','B',57,imp,0,
    encode(sha256(convert_to(payment::text,'UTF8')),'hex'));
  INSERT INTO journal_entry_lines(journal_entry_id,account_number,debit_amount,credit_amount,currency,sort_order) VALUES
    (payment,'2440',125,0,'SEK',0),(payment,'1930',0,125,'SEK',1);
  UPDATE journal_entries SET status='posted' WHERE id=payment;

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  j:=create_provider_migration_job(company,u,consent,ARRAY['supplierInvoices'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'supplierInvoices',1,
    '[{"source_id":"supplier-invoice","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO ch FROM migration_job_chunks WHERE job_id=j.id AND source_id='supplier-invoice';
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object(
    'id',ch,'party_source_id','supplier-1','party',jsonb_build_object('name','Supplier'),
    'row',jsonb_build_object('supplier_invoice_number','LF-1','invoice_date','2026-01-05','due_date','2026-02-05',
      'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
      'vat_treatment','standard_25','status','registered','remaining_amount',125,'is_credit_note',false),
    'items','[{"sort_order":1,"description":"Test","quantity":1,"unit_price":100,"line_total":100,"account_number":"4000","vat_rate":0.25,"vat_amount":25}]'::jsonb,
    'link',jsonb_build_object('kind','supplier','invoiceDate','2026-01-05','totalSek',125))));
  SELECT target_id INTO inv FROM migration_job_chunks WHERE id=ch;
  ASSERT inv IS NOT NULL,'fixture invoice was not imported';

  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',ch)));
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',ch,'payment',jsonb_build_object('journal_entry_id',payment,'link_basis','rule_counterparty'))));
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  ASSERT (SELECT phase='settle' FROM migration_jobs WHERE id=j.id),'job did not reach the settle phase';
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',ch)));

  ASSERT (SELECT state='done' FROM migration_job_chunks WHERE id=ch),'the chunk did not settle';
  ASSERT (SELECT count(*)=1 FROM supplier_invoice_payments WHERE supplier_invoice_id=inv AND journal_entry_id=payment),
    'the source payment was not linked';
  ASSERT (SELECT link_basis='rule_counterparty' FROM supplier_invoice_payments WHERE supplier_invoice_id=inv),
    'the payment row does not name the rule that planned the pair';
  RESET ROLE;
END $$;
ROLLBACK;
