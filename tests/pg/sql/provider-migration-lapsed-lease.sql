-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test/staging database; this script does not create a local database.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); j public.migration_jobs; k public.migration_jobs; i integer;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Lapsed lease test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Lapsed lease test','visma','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'visma','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');

  -- The worker's calls alone: neither a browser session nor anon reaches them.
  ASSERT NOT has_function_privilege('authenticated','public.claim_provider_migration_job(uuid,uuid)','EXECUTE'),
    'authenticated may claim a job';
  ASSERT NOT has_function_privilege('anon','public.provider_migration_progress(public.migration_jobs)','EXECUTE'),
    'anon may read a job''s progress mark';
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  j:=create_provider_migration_job(company,u,consent,ARRAY['customers'],NULL);

  -- A first claim counts nothing and stamps where the job stands.
  j:=claim_provider_migration_job(worker,j.id);
  ASSERT j.state='running' AND j.failures=0 AND j.error_code IS NULL,'a first claim counted a failure';
  ASSERT j.claim_mark IS NOT NULL,'the claim left no mark';

  -- A live lease is not taken over, and not counted.
  k:=claim_provider_migration_job(gen_random_uuid(),j.id);
  ASSERT k.id IS NULL,'a live lease was claimed';

  -- A job claimed before the migration has no mark: its lapsed lease reads
  -- as progress, so the count is reset rather than raised, and the claim
  -- stamps a mark the next lapse is judged against.
  UPDATE migration_jobs SET claim_mark=NULL,failures=3,error_code='MIGRATION_RETRY',
    lease_until=clock_timestamp()-interval '1 second' WHERE id=j.id;
  j:=claim_provider_migration_job(gen_random_uuid(),j.id);
  ASSERT j.state='running' AND j.failures=0 AND j.error_code IS NULL,
    format('a job without a mark was counted: failures %s, code %s',j.failures,j.error_code);
  ASSERT j.claim_mark IS NOT NULL,'the claim of a job without a mark stamped none';

  -- The worker is ended four runs in a row without moving the job: each
  -- lapsed lease is counted and the job is claimed again.
  FOR i IN 1..4 LOOP
    UPDATE migration_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=j.id;
    j:=claim_provider_migration_job(gen_random_uuid(),j.id);
    ASSERT j.state='running' AND j.failures=i AND j.error_code='MIGRATION_LEASE_LAPSED',
      format('lapsed lease %s was not counted: state %s, failures %s',i,j.state,j.failures);
  END LOOP;

  -- The fifth parks it, and returns it parked so the worker can report it.
  UPDATE migration_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=j.id;
  j:=claim_provider_migration_job(gen_random_uuid(),j.id);
  ASSERT j.state='needs_attention' AND j.failures=5 AND j.error_code='MIGRATION_LEASE_LAPSED',
    format('the fifth lapsed lease did not park the job: state %s, failures %s',j.state,j.failures);
  ASSERT j.worker_id IS NULL AND j.lease_until IS NULL,'a parked job kept its lease';
  k:=claim_provider_migration_job(gen_random_uuid(),j.id);
  ASSERT k.id IS NULL,'a parked job was claimed again';

  -- Fortsätt importen re-arms it with a clean count.
  PERFORM retry_provider_migration_job(j.id,company,u);
  j:=claim_provider_migration_job(worker,j.id);
  ASSERT j.state='running' AND j.failures=0 AND j.error_code IS NULL,'a retried job kept its failures';

  -- A run that moved the job before it was ended is a deferral: nothing is
  -- counted, and an earlier count is cleared as a clean release clears it.
  UPDATE migration_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=j.id;
  j:=claim_provider_migration_job(worker,j.id);
  ASSERT j.failures=1,'the lapsed lease before the progress was not counted';
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'customers',1,
    '[{"source_id":"c1","payload":"cipher","payload_hash":"hash"}]',0);
  UPDATE migration_jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=j.id;
  j:=claim_provider_migration_job(worker,j.id);
  ASSERT j.state='running' AND j.failures=0 AND j.error_code IS NULL,
    format('a run that saved a page was counted as a failure: failures %s',j.failures);

  -- A released job has no lease: claiming it again counts nothing, however
  -- little the run before it moved.
  PERFORM release_provider_migration_job(j.id,worker,j.attempt,'MIGRATION_RETRY',0);
  j:=claim_provider_migration_job(worker,j.id);
  ASSERT j.state='running' AND j.failures=1 AND j.error_code='MIGRATION_RETRY',
    format('a released job was counted by the claim: failures %s, code %s',j.failures,j.error_code);
END $$;
ROLLBACK;
