BEGIN;
DO $$
DECLARE u uuid:=gen_random_uuid(); outsider uuid:=gen_random_uuid(); viewer uuid:=gen_random_uuid();
  company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); job uuid:=gen_random_uuid();
  chunk uuid:=gen_random_uuid(); another_job uuid:=gen_random_uuid(); before_chunk jsonb; finished_at timestamptz;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (outsider,outsider||'@test.invalid','00000000-0000-0000-0000-000000000000'),
    (viewer,viewer||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Finish review test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner'),(company,viewer,'viewer');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Finish test','bokio','556000-0001');
  INSERT INTO migration_jobs(id,company_id,user_id,consent_id,provider,account_key,resources,state,phase)
    VALUES(job,company,u,consent,'bokio','account',ARRAY['supplierInvoices'],'needs_attention','completed');
  INSERT INTO migration_job_chunks(id,job_id,company_id,resource,source_id,resource_order,payload,payload_hash,state,error_code,error_phase)
    VALUES(chunk,job,company,'supplierInvoices','source-collision',0,'encrypted-fixture','hash','needs_attention','MIGRATION_INVOICE_NUMBER_TAKEN','import');
  SELECT to_jsonb(c) INTO before_chunk FROM migration_job_chunks c WHERE id=chunk;
  BEGIN
    PERFORM finish_provider_migration_with_review(job,company,viewer);
    RAISE EXCEPTION 'viewer finished';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN'; END;
  BEGIN
    PERFORM finish_provider_migration_with_review(job,company,outsider);
    RAISE EXCEPTION 'outsider finished';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_WRITE_FORBIDDEN'; END;
  UPDATE migration_jobs SET phase='import' WHERE id=job;
  BEGIN
    PERFORM finish_provider_migration_with_review(job,company,u);
    RAISE EXCEPTION 'unfinished phase accepted';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_REVIEW_NOT_FINISHABLE'; END;
  UPDATE migration_jobs SET phase='completed',error_code='PROVIDER_AUTH_EXPIRED' WHERE id=job;
  BEGIN
    PERFORM finish_provider_migration_with_review(job,company,u);
    RAISE EXCEPTION 'job error accepted';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_REVIEW_NOT_FINISHABLE'; END;
  UPDATE migration_jobs SET error_code=NULL WHERE id=job;
  INSERT INTO migration_job_chunks(job_id,company_id,resource,source_id,resource_order,payload,payload_hash,state)
    VALUES(job,company,'supplierInvoices','pending',1,'encrypted-fixture','hash','pending');
  BEGIN
    PERFORM finish_provider_migration_with_review(job,company,u);
    RAISE EXCEPTION 'pending work accepted';
  EXCEPTION WHEN raise_exception THEN ASSERT SQLERRM='MIGRATION_REVIEW_NOT_FINISHABLE'; END;
  DELETE FROM migration_job_chunks WHERE job_id=job AND source_id='pending';
  ASSERT finish_provider_migration_with_review(job,company,u)=1;
  ASSERT (SELECT state='completed' AND review_deferred_at IS NOT NULL FROM migration_jobs WHERE id=job);
  ASSERT (SELECT to_jsonb(c)=before_chunk FROM migration_job_chunks c WHERE id=chunk),'review evidence was modified';
  ASSERT (SELECT count(*)=1 FROM audit_log WHERE record_id=job AND description LIKE 'Import execution finished%'),'manual decision not audited';
  SELECT review_deferred_at INTO finished_at FROM migration_jobs WHERE id=job;
  ASSERT finish_provider_migration_with_review(job,company,u)=1;
  ASSERT (SELECT review_deferred_at=finished_at FROM migration_jobs WHERE id=job),'replay changed decision';
  ASSERT (SELECT count(*)=1 FROM audit_log WHERE record_id=job AND description LIKE 'Import execution finished%'),'replay duplicated audit';
  ASSERT NOT has_function_privilege('authenticated','finish_provider_migration_with_review(uuid,uuid,uuid)','EXECUTE');
  ASSERT NOT has_function_privilege('anon','finish_provider_migration_with_review(uuid,uuid,uuid)','EXECUTE');
  ASSERT has_function_privilege('service_role','finish_provider_migration_with_review(uuid,uuid,uuid)','EXECUTE');
  INSERT INTO migration_jobs(id,company_id,user_id,consent_id,provider,account_key,resources,state,phase)
    VALUES(another_job,company,u,consent,'bokio','account',ARRAY['supplierInvoices'],'queued','discover');
  BEGIN
    PERFORM retry_provider_migration_job(job,company,u);
    RAISE EXCEPTION 'old review restarted during active import';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  ASSERT (SELECT state='completed' FROM migration_jobs WHERE id=job),'conflicting retry changed saved review';
  ASSERT (SELECT state='needs_attention' FROM migration_job_chunks WHERE id=chunk),'failed retry discarded review';
  DELETE FROM migration_jobs WHERE id=another_job;
  PERFORM retry_provider_migration_job(job,company,u);
  ASSERT (SELECT state='queued' AND review_deferred_at=finished_at FROM migration_jobs WHERE id=job),'saved review cannot resume';
  ASSERT (SELECT state='pending' AND payload='encrypted-fixture' FROM migration_job_chunks WHERE id=chunk);
  UPDATE migration_job_chunks SET state='done' WHERE id=chunk;
  UPDATE migration_jobs SET state='completed',phase='completed',review_deferred_at=NULL WHERE id=job;
  PERFORM retry_provider_migration_job(job,company,u);
  ASSERT (SELECT state='completed' FROM migration_jobs WHERE id=job),'ordinary completed job reopened';
END $$;
ROLLBACK;
