-- Every fixture and mutation is rolled back. Run only against an already
-- migrated test/staging database; this script does not create a local database.
BEGIN;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid();
  worker uuid:=gen_random_uuid(); stranger uuid:=gen_random_uuid(); j public.migration_jobs; n bigint;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Refused register test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Refused register test','fortnox','556000-0000');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'fortnox','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status)
    VALUES(company,u,'test.se',md5(company::text),4,'completed');

  -- The worker's call alone: neither a browser session nor anon reaches it.
  ASSERT NOT has_function_privilege('authenticated',
    'public.skip_provider_migration_resource(uuid,uuid,integer,text,integer,text)','EXECUTE'),'authenticated may skip a register';
  ASSERT NOT has_function_privilege('anon',
    'public.skip_provider_migration_resource(uuid,uuid,integer,text,integer,text)','EXECUTE'),'anon may skip a register';
  ASSERT has_function_privilege('service_role',
    'public.skip_provider_migration_resource(uuid,uuid,integer,text,integer,text)','EXECUTE'),'the worker cannot skip a register';

  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;

  j:=create_provider_migration_job(company,u,consent,ARRAY['customers','suppliers','salesInvoices','supplierInvoices'],NULL);
  ASSERT j.refused_resources='{}'::jsonb,'a new job starts with refused registers';
  j:=claim_provider_migration_job(worker,j.id);

  -- Only a known reason, for the register and page this attempt is reading,
  -- from the worker that holds the lease.
  BEGIN
    PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'customers',1,'timeout');
    RAISE EXCEPTION 'TEST: unknown refusal reason accepted';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_REFUSAL_REASON_INVALID' THEN RAISE; END IF; END;
  BEGIN
    PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'suppliers',1,'license');
    RAISE EXCEPTION 'TEST: a register other than the current one was skipped';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_CURSOR_CONFLICT' THEN RAISE; END IF; END;
  BEGIN
    PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'customers',2,'license');
    RAISE EXCEPTION 'TEST: a page other than the current one was skipped';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_CURSOR_CONFLICT' THEN RAISE; END IF; END;
  BEGIN
    PERFORM skip_provider_migration_resource(j.id,stranger,j.attempt,'customers',1,'license');
    RAISE EXCEPTION 'TEST: a worker without the lease skipped a register';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_LEASE_LOST' THEN RAISE; END IF; END;

  -- A refusal moves the job on to the next register and ends the failure
  -- streak a job parked before this migration carries.
  UPDATE migration_jobs SET failures=3,error_code='PROVIDER_RESOURCE_FORBIDDEN' WHERE id=j.id;
  PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'customers',1,'license');
  SELECT * INTO j FROM migration_jobs WHERE id=j.id;
  ASSERT j.phase='discover' AND j.resource_index=2 AND j.next_page=1 AND j.state='running',
    'the job did not move on to the next register';
  ASSERT j.failures=0 AND j.error_code IS NULL,'a refusal kept the failure streak';
  ASSERT j.refused_resources='{"customers":"license"}'::jsonb,'the refused register was not recorded';
  -- A replay after a lost acknowledgement moves nothing a second time.
  BEGIN
    PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'customers',1,'license');
    RAISE EXCEPTION 'TEST: a replayed skip moved the cursor again';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_CURSOR_CONFLICT' THEN RAISE; END IF; END;

  -- Suppliers answer page 1, then refuse page 2 (a right revoked mid-run):
  -- the saved page stays and imports.
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,
    '[{"source_id":"s1","payload":"cipher","payload_hash":"hash"}]',2);
  PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'suppliers',2,'permission');
  SELECT count(*) INTO n FROM migration_job_chunks WHERE job_id=j.id AND resource='suppliers' AND state='pending';
  ASSERT n=1,'a page saved before the refusal was dropped';
  PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'salesInvoices',1,'license');
  -- Refusing the last register ends discovery like its last page would.
  PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'supplierInvoices',1,'permission');
  SELECT * INTO j FROM migration_jobs WHERE id=j.id;
  ASSERT j.phase='import' AND j.resource_index=5,'refusing the last register did not end discovery';
  ASSERT j.refused_resources=
    '{"customers":"license","suppliers":"permission","salesInvoices":"license","supplierInvoices":"permission"}'::jsonb,
    'refused registers were not all recorded';
  BEGIN
    PERFORM skip_provider_migration_resource(j.id,worker,j.attempt,'supplierInvoices',1,'permission');
    RAISE EXCEPTION 'TEST: a register was skipped outside discovery';
  EXCEPTION WHEN OTHERS THEN IF SQLERRM<>'MIGRATION_CURSOR_CONFLICT' THEN RAISE; END IF; END;

  -- A refused register is not a failure: the job completes with what the
  -- provider handed out, and keeps saying what it did not.
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object(
    'id',(SELECT id FROM migration_job_chunks WHERE job_id=j.id AND source_id='s1'),'row',jsonb_build_object('name','Supplier'))));
  SELECT count(*) INTO n FROM suppliers WHERE company_id=company;
  ASSERT n=1,'the register saved before the refusal was not imported';
  FOR n IN 1..4 LOOP PERFORM advance_provider_migration_job(j.id,worker,j.attempt); END LOOP;
  SELECT * INTO j FROM migration_jobs WHERE id=j.id;
  ASSERT j.state='completed' AND j.phase='completed','a job with refused registers did not complete';
  ASSERT j.refused_resources ? 'customers','the completed job lost its refused registers';

  BEGIN
    UPDATE migration_jobs SET refused_resources='[]'::jsonb WHERE id=j.id;
    RAISE EXCEPTION 'TEST: a non-object refused_resources was stored';
  EXCEPTION WHEN check_violation THEN NULL; END;
END $$;
