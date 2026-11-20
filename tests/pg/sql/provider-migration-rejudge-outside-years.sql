-- A retry judges again the invoices declined as outside the imported fiscal
-- years once more years were imported (migration 20261118221500, crm#2002).
-- Every fixture and mutation is rolled back. A transaction keeps one now(),
-- so the imports carry explicit imported_at times around it: before the
-- records were judged, and after.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); j public.migration_jobs; n bigint; stale bigint;
  kept uuid; later uuid; zero uuid; rcpt jsonb;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Rejudge test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Rejudge test','fortnox','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'fortnox','not-a-real-token');
  -- The first year, imported before the register import judged anything.
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status,fiscal_year_start,fiscal_year_end,imported_at)
    VALUES(company,u,'2025.se',md5(company::text||'2025'),4,'completed','2025-01-01','2025-12-31',now()-interval '1 hour');

  ASSERT NOT has_function_privilege('anon','public.provider_migration_stale_year_skips(uuid)','EXECUTE'),
    'anon may list a job''s records';
  ASSERT has_function_privilege('authenticated','public.provider_migration_counts(uuid)','EXECUTE'),
    'the wizard can no longer read the counts';
  ASSERT NOT has_function_privilege('authenticated','public.retry_provider_migration_job(uuid,uuid,uuid)','EXECUTE'),
    'a client can retry a job directly';
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  -- Three invoices: one the import could not finish, one issued in a year
  -- not yet imported, one declined for a reason of its own.
  j:=create_provider_migration_job(company,u,consent,ARRAY['salesInvoices'],'{"start":"2025-01-01","end":"2025-12-31"}');
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'salesInvoices',1,
    '[{"source_id":"kept","payload":"cipher","payload_hash":"hash"},{"source_id":"later","payload":"cipher","payload_hash":"hash"},{"source_id":"zero","payload":"cipher","payload_hash":"hash"}]',NULL);
  SELECT id INTO kept FROM migration_job_chunks WHERE job_id=j.id AND source_id='kept';
  SELECT id INTO later FROM migration_job_chunks WHERE job_id=j.id AND source_id='later';
  SELECT id INTO zero FROM migration_job_chunks WHERE job_id=j.id AND source_id='zero';
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',kept,'error','MIGRATION_DETAIL_RETRY'),
    jsonb_build_object('id',later,'skip','outsideFiscalYears'),
    jsonb_build_object('id',zero,'skip','zeroTotal')));
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  ASSERT (SELECT phase='completed' AND state='needs_attention' FROM migration_jobs WHERE id=j.id),
    'the job did not stop for review';

  -- No year was imported after the invoices were judged: nothing to judge again.
  SELECT skipped,outside_years_stale INTO n,stale FROM provider_migration_counts(j.id) WHERE resource='salesInvoices';
  ASSERT n=2 AND stale=0,format('judged against the same years, %s of %s skips read as stale',stale,n);
  PERFORM retry_provider_migration_job(j.id,company,u);
  ASSERT (SELECT state='pending' FROM migration_job_chunks WHERE id=kept),'the failed record was not re-queued';
  ASSERT (SELECT state='skipped' AND receipt->>'reason'='outsideFiscalYears' FROM migration_job_chunks WHERE id=later),
    'a retry re-queued a skip no import has changed since';
  j:=claim_provider_migration_job(worker,j.id);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',kept,'error','MIGRATION_DETAIL_RETRY')));
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;

  -- A failed import of the next year grows nothing.
  RESET ROLE;
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status,fiscal_year_start,fiscal_year_end,imported_at)
    VALUES(company,u,'2026-failed.se',md5(company::text||'2026-failed'),4,'failed','2026-01-01','2026-12-31',now()+interval '1 minute');
  SET LOCAL ROLE service_role;
  SELECT outside_years_stale INTO stale FROM provider_migration_counts(j.id) WHERE resource='salesInvoices';
  ASSERT stale=0,'a failed import made a skip stale';

  -- The next year is imported while the job waits for its review.
  RESET ROLE;
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status,fiscal_year_start,fiscal_year_end,imported_at)
    VALUES(company,u,'2026.se',md5(company::text||'2026'),4,'completed','2026-01-01','2026-12-31',now()+interval '1 minute');
  SET LOCAL ROLE service_role;
  SELECT skipped,outside_years_stale INTO n,stale FROM provider_migration_counts(j.id) WHERE resource='salesInvoices';
  ASSERT n=2 AND stale=1,format('after the next year was imported, %s of %s skips read as stale (expected 1 of 2)',stale,n);
  ASSERT (SELECT array_agg(id) FROM provider_migration_stale_year_skips(j.id) id)=ARRAY[later],
    'the stale skips are not exactly the invoice declined as outside the years';

  -- The retry hands that invoice back to the import phase, as a fresh record,
  -- and leaves the skip with a reason of its own alone.
  PERFORM retry_provider_migration_job(j.id,company,u);
  SELECT receipt INTO rcpt FROM migration_job_chunks WHERE id=later;
  ASSERT (SELECT state='pending' AND target_id IS NULL AND error_code IS NULL FROM migration_job_chunks WHERE id=later)
    AND rcpt='{}'::jsonb,format('the stale skip was not re-queued as a fresh record: %s',rcpt);
  ASSERT (SELECT state='skipped' AND receipt->>'reason'='zeroTotal' FROM migration_job_chunks WHERE id=zero),
    'a retry re-queued a skip with a reason of its own';
  ASSERT (SELECT state='pending' AND receipt->>'previous_error_code'='MIGRATION_DETAIL_RETRY' FROM migration_job_chunks WHERE id=kept),
    'the failed record lost its retry trace';
  ASSERT (SELECT phase='import' AND state='queued' FROM migration_jobs WHERE id=j.id),'the retried job is not back in its import phase';
  SELECT outside_years_stale INTO stale FROM provider_migration_counts(j.id) WHERE resource='salesInvoices';
  ASSERT stale=0,'a re-queued record still reads as a stale skip';

  -- The import phase does not end before the worker has judged it again.
  j:=claim_provider_migration_job(worker,j.id);
  BEGIN
    PERFORM advance_provider_migration_job(j.id,worker,j.attempt);
    RAISE EXCEPTION 'TEST: import phase ended with a record to judge';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_PHASE_NOT_FINISHED' THEN RAISE; END IF; END;
  -- Still outside the years: declined again.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(
    jsonb_build_object('id',kept,'error','MIGRATION_DETAIL_RETRY'),
    jsonb_build_object('id',later,'skip','outsideFiscalYears')));
  ASSERT (SELECT state='skipped' AND receipt->>'reason'='outsideFiscalYears' FROM migration_job_chunks WHERE id=later),
    'the judged-again invoice was not declined again';
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;

  -- An accepted job is not reopened by a retry, stale skips or not.
  PERFORM accept_provider_migration_job(j.id,company,u);
  PERFORM retry_provider_migration_job(j.id,company,u);
  ASSERT (SELECT state='completed' FROM migration_jobs WHERE id=j.id),'retry reopened an accepted job';
  ASSERT (SELECT state='skipped' FROM migration_job_chunks WHERE id=later),'retry re-queued a record of an accepted job';

  ASSERT NOT EXISTS(SELECT 1 FROM journal_entries WHERE company_id=company),'judging again wrote a journal entry';
  RESET ROLE;
END $$;
SELECT 'provider migration rejudge assertions passed' AS result;
ROLLBACK;
