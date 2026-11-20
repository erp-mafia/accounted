-- Accepting a finished provider import with records that need attention, and
-- a retry that records what it retried (migration 20261005193000).
-- Every fixture and mutation is rolled back.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); j public.migration_jobs; accepted public.migration_jobs;
  good uuid; bad uuid; inv uuid; n bigint; rec jsonb; rcpt jsonb;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (outsider,outsider||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Review test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Review test','visma','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'visma','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  -- One healthy customer and one the source left without a name.
  j:=create_provider_migration_job(company,u,consent,ARRAY['customers'],NULL);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'customers',1,
    '[{"source_id":"good","payload":"cipher","payload_hash":"hash"},{"source_id":"bad","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO good FROM migration_job_chunks WHERE job_id=j.id AND source_id='good';
  SELECT id INTO bad FROM migration_job_chunks WHERE job_id=j.id AND source_id='bad';
  rec:=jsonb_build_array(jsonb_build_object('id',good,'row',jsonb_build_object('name','Good','customer_type','swedish_business')),
    jsonb_build_object('id',bad,'row',jsonb_build_object('name',NULL)));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,rec);

  -- A job still at work is never accepted: its unprocessed records would vanish.
  BEGIN
    PERFORM accept_provider_migration_job(j.id,company,u);
    RAISE EXCEPTION 'TEST: unfinished job accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_NOT_ACCEPTABLE' THEN RAISE; END IF; END;
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  ASSERT (SELECT phase='completed' AND state='needs_attention' FROM migration_jobs WHERE id=j.id),
    'finished job with a failed record did not stop for review';

  -- A retry re-queues only the failed record and keeps its last code.
  PERFORM retry_provider_migration_job(j.id,company,u);
  ASSERT (SELECT state='done' FROM migration_job_chunks WHERE id=good),'retry touched a healthy record';
  SELECT receipt INTO rcpt FROM migration_job_chunks WHERE id=bad;
  ASSERT (SELECT state='pending' AND error_code IS NULL FROM migration_job_chunks WHERE id=bad),'failed record not re-queued';
  ASSERT rcpt->>'previous_error_code'='23502','retry did not keep the code it retried';
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec->1));
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  ASSERT (SELECT state='needs_attention' AND error_code='23502' AND receipt->>'previous_error_code'='23502'
    FROM migration_job_chunks WHERE id=bad),'an unchanged retry is not recognisable as unchanged';
  ASSERT (SELECT phase='completed' AND state='needs_attention' FROM migration_jobs WHERE id=j.id),'retried job did not stop for review';

  -- Only a member accepts; an outsider changes nothing.
  BEGIN
    PERFORM accept_provider_migration_job(j.id,company,outsider);
    RAISE EXCEPTION 'TEST: outsider accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_WRITE_FORBIDDEN' THEN RAISE; END IF; END;
  BEGIN
    PERFORM accept_provider_migration_job(gen_random_uuid(),company,u);
    RAISE EXCEPTION 'TEST: unknown job accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_JOB_NOT_FOUND' THEN RAISE; END IF; END;

  accepted:=accept_provider_migration_job(j.id,company,u);
  ASSERT accepted.state='completed' AND accepted.review_accepted_by=u AND accepted.review_accepted_at IS NOT NULL,
    'acceptance did not finish the job with who and when';
  -- The record that needs attention is still there, as it was: listed, not dropped.
  ASSERT (SELECT state='needs_attention' AND error_code='23502' AND error_phase='import' FROM migration_job_chunks WHERE id=bad),
    'acceptance changed the record that needs attention';
  SELECT needs_attention INTO n FROM provider_migration_counts(j.id) WHERE resource='customers';
  ASSERT n=1,'accepted job no longer counts its open record';
  -- A second acceptance (a lost response) answers with the same finished job.
  ASSERT (accept_provider_migration_job(j.id,company,u)).review_accepted_at=accepted.review_accepted_at,
    'a repeated acceptance changed the job';
  -- Retrying a finished job is a no-op.
  PERFORM retry_provider_migration_job(j.id,company,u);
  ASSERT (SELECT state='completed' FROM migration_jobs WHERE id=j.id),'retry reopened an accepted job';

  -- The accepted job no longer holds the company: a new import can start.
  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices'],NULL);
  ASSERT j.id<>accepted.id AND j.state='queued','an accepted job still blocks a new import';

  -- A voucher-link review keeps what it found; a later success clears it.
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"inv-1","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO inv FROM migration_job_chunks WHERE job_id=j.id AND source_id='inv-1';
  rec:=jsonb_build_object('id',inv,'party_source_id','good','party',jsonb_build_object('name','Good'),
    'row',jsonb_build_object('invoice_number','R-1','document_type','invoice','invoice_date','2026-01-05','due_date','2026-02-05',
      'currency','SEK','subtotal',100,'subtotal_sek',100,'vat_amount',25,'vat_amount_sek',25,'total',125,'total_sek',125,
      'vat_treatment','standard_25','vat_rate',25,'status','sent'),
    'items','[{"sort_order":1,"description":"Test","quantity":1,"unit_price":100,"line_total":100,"vat_rate":25,"vat_amount":25,"line_type":"product"}]'::jsonb,
    'link',jsonb_build_object('kind','customer','invoiceDate','2026-01-05','totalSek',125,'invoiceNumber','R-1',
      'sourceVoucher',jsonb_build_object('series','B','number',7)));
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(rec));
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',inv,
    'report',jsonb_build_object('outcome','amountMismatch'),'error','MIGRATION_REGISTRATION_REVIEW',
    'review',jsonb_build_object('kind','registration','outcome','amountMismatch','bookedSek',120,'expectedSek',125))));
  SELECT receipt INTO rcpt FROM migration_job_chunks WHERE id=inv;
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_REGISTRATION_REVIEW' AND error_phase='link'
    FROM migration_job_chunks WHERE id=inv),'review outcome not recorded';
  ASSERT rcpt#>>'{review,outcome}'='amountMismatch' AND (rcpt#>>'{review,bookedSek}')::numeric=120,
    'review detail was not kept';
  ASSERT rcpt#>>'{link,invoiceNumber}'='R-1','review overwrote the import receipt';
  FOR n IN 1..3 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  ASSERT (SELECT phase='completed' AND state='needs_attention' FROM migration_jobs WHERE id=j.id),'link review did not stop for review';
  PERFORM retry_provider_migration_job(j.id,company,u);
  ASSERT (SELECT state='imported' AND receipt->>'previous_error_code'='MIGRATION_REGISTRATION_REVIEW'
    FROM migration_job_chunks WHERE id=inv),'link review not re-queued to its own phase';
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  -- A code raised by name is stored by name, not as P0001.
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',inv,
    'error','BOKIO_SOURCE_IDENTITY_MISMATCH')));
  SELECT receipt INTO rcpt FROM migration_job_chunks WHERE id=inv;
  ASSERT (SELECT error_code='BOKIO_SOURCE_IDENTITY_MISMATCH' FROM migration_job_chunks WHERE id=inv),
    'a named code was stored as its SQLSTATE';
  ASSERT NOT (rcpt ? 'review'),'a stale review survived a different outcome';
  FOR n IN 1..3 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  PERFORM retry_provider_migration_job(j.id,company,u);
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM commit_provider_migration_followup(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',inv,
    'report',jsonb_build_object('outcome','noRef'))));
  SELECT receipt INTO rcpt FROM migration_job_chunks WHERE id=inv;
  ASSERT (SELECT state='done' FROM migration_job_chunks WHERE id=inv),'successful retry did not finish the record';
  ASSERT NOT (rcpt ? 'review') AND NOT (rcpt ? 'previous_error_code') AND rcpt#>>'{registration,outcome}'='noRef',
    'a finished record kept its review traces';
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
  ASSERT (SELECT state='completed' AND review_accepted_at IS NULL FROM migration_jobs WHERE id=j.id),
    'a clean job was marked as accepted';
  ASSERT NOT EXISTS(SELECT 1 FROM journal_entries WHERE company_id=company),'review handling wrote a journal entry';

  ASSERT NOT has_function_privilege('authenticated','public.accept_provider_migration_job(uuid,uuid,uuid)','EXECUTE'),
    'a client can accept a job directly';
  ASSERT NOT has_function_privilege('anon','public.accept_provider_migration_job(uuid,uuid,uuid)','EXECUTE'),
    'anonymous acceptance allowed';
  RESET ROLE;
END $$;
SELECT 'provider migration review and acceptance assertions passed' AS result;
ROLLBACK;
