BEGIN;
DO $$
DECLARE u uuid:=gen_random_uuid(); company uuid:=gen_random_uuid(); consent uuid:=gen_random_uuid(); worker uuid:=gen_random_uuid();
  old_job public.migration_jobs; j public.migration_jobs; original_chunk uuid; new_chunk uuid; target uuid; mapping uuid; old_row jsonb;
  a text:=repeat('a',64); b text:=repeat('b',64); c text:=repeat('c',64); baseline_count integer;
BEGIN
  INSERT INTO auth.users(id,email,instance_id) VALUES(u,u||'@test.invalid','00000000-0000-0000-0000-000000000000');
  INSERT INTO companies(id,name,entity_type,created_by) VALUES(company,'Resync test','aktiebolag',u);
  INSERT INTO company_members(company_id,user_id,role) VALUES(company,u,'owner');
  INSERT INTO provider_consents(id,company_id,name,provider,org_number) VALUES(consent,company,'Resync','bokio','556000-0001');
  INSERT INTO provider_consent_tokens(consent_id,provider,access_token) VALUES(consent,'bokio','not-a-real-token');
  INSERT INTO sie_imports(company_id,user_id,filename,file_hash,sie_type,status) VALUES(company,u,'test.se',md5(company::text),4,'completed');
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  PERFORM set_config('request.jwt.claim.role','service_role',true);
  SET LOCAL ROLE service_role;
  old_job:=create_provider_migration_job(company,u,consent,ARRAY['suppliers'],NULL);
  old_job:=claim_provider_migration_job(worker,old_job.id);
  -- Old versions retained ciphertext and integrity hashes, without a semantic hash.
  PERFORM save_provider_migration_page(old_job.id,worker,old_job.attempt,'suppliers',1,
    '[{"source_id":"sup-1","payload":"encrypted-original","payload_hash":"original-integrity"}]',NULL);
  SELECT id INTO original_chunk FROM migration_job_chunks WHERE job_id=old_job.id;
  PERFORM commit_provider_migration_records(old_job.id,worker,old_job.attempt,jsonb_build_array(jsonb_build_object(
    'id',original_chunk,'row',jsonb_build_object('name','Original supplier','org_number','5560000001'))));
  SELECT target_id INTO target FROM migration_job_chunks WHERE id=original_chunk;
  SELECT id INTO mapping FROM migration_source_records WHERE company_id=company AND source_id='sup-1';
  SELECT to_jsonb(s) INTO old_row FROM suppliers s WHERE id=target;
  UPDATE migration_jobs SET state='completed',phase='completed',worker_id=NULL,lease_until=NULL WHERE id=old_job.id;
  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers'],NULL);j:=claim_provider_migration_job(worker,j.id);
  SELECT count(*) INTO baseline_count FROM read_provider_source_hash_baselines(j.id,worker,j.attempt,'suppliers',ARRAY['sup-1']);
  ASSERT baseline_count=1,'old retained snapshot could not initialize the semantic baseline';
  PERFORM initialize_provider_source_hashes(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object(
    'record_id',mapping,'chunk_id',original_chunk,'payload_hash','wrong-integrity','source_hash',a)));
  ASSERT (SELECT source_hash IS NULL FROM migration_source_records WHERE id=mapping),'stale snapshot proof accepted';
  PERFORM initialize_provider_source_hashes(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object(
    'record_id',mapping,'chunk_id',original_chunk,'payload_hash','original-integrity','source_hash',a)));
  ASSERT (SELECT payload_hash='original-integrity' AND payload='encrypted-original' FROM migration_job_chunks WHERE id=original_chunk),
    'baseline initialization changed historical snapshot evidence';
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,jsonb_build_array(
    jsonb_build_object('source_id','sup-1','payload','new-encryption','payload_hash','new-integrity','source_hash',a),
    jsonb_build_object('source_id','sup-2','payload','new-source','payload_hash','second-integrity','source_hash',b)),NULL);
  ASSERT (SELECT state='skipped' AND target_id=target AND receipt->>'reason'='unchanged' FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-1'),
    'unchanged source was re-imported';
  SELECT id INTO new_chunk FROM migration_job_chunks WHERE job_id=j.id AND source_id='sup-2';
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',new_chunk,
    'source_hash',b,'row',jsonb_build_object('name','New supplier','org_number','5560000002'))));
  ASSERT (SELECT imported=1 AND unchanged=1 AND skipped=0 FROM provider_migration_counts(j.id)),'delta counts include unchanged as new or excluded';
  ASSERT (SELECT source_hash=b FROM migration_source_records WHERE company_id=company AND source_id='sup-2'),'new source version was not committed';
  UPDATE migration_jobs SET state='completed',phase='completed',worker_id=NULL,lease_until=NULL WHERE id=j.id;
  j:=create_provider_migration_job(company,u,consent,ARRAY['suppliers'],NULL);j:=claim_provider_migration_job(worker,j.id);
  PERFORM save_provider_migration_page(j.id,worker,j.attempt,'suppliers',1,jsonb_build_array(jsonb_build_object(
    'source_id','sup-1','payload','changed-source','payload_hash','changed-integrity','source_hash',c)),NULL);
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_SOURCE_CHANGED' AND target_id=target
    FROM migration_job_chunks WHERE job_id=j.id),'changed source disappeared or overwrote local data';
  ASSERT (SELECT imported=0 AND unchanged=0 AND needs_attention=1 FROM provider_migration_counts(j.id)),'changed existing source counted as new';
  SELECT id INTO new_chunk FROM migration_job_chunks WHERE job_id=j.id;
  UPDATE migration_jobs SET state='needs_attention',phase='completed',worker_id=NULL,lease_until=NULL WHERE id=j.id;
  PERFORM retry_provider_migration_job(j.id,company,u);j:=claim_provider_migration_job(worker,j.id);
  PERFORM commit_provider_migration_records(j.id,worker,j.attempt,jsonb_build_array(jsonb_build_object('id',new_chunk,
    'source_hash',c,'row',jsonb_build_object('name','Changed supplier','org_number','5560000001'))));
  ASSERT (SELECT state='needs_attention' AND error_code='MIGRATION_SOURCE_CHANGED' FROM migration_job_chunks WHERE id=new_chunk),
    'retry silently accepted a changed source';
  ASSERT (SELECT to_jsonb(s)=old_row FROM suppliers s WHERE id=target),'source re-sync overwrote existing local fields';
  ASSERT (SELECT source_hash=a FROM migration_source_records WHERE id=mapping),'unreviewed source version replaced baseline';
  ASSERT NOT has_function_privilege('authenticated','read_provider_source_hash_baselines(uuid,uuid,integer,text,text[])','EXECUTE');
  ASSERT NOT has_function_privilege('authenticated','initialize_provider_source_hashes(uuid,uuid,integer,jsonb)','EXECUTE');
  RESET ROLE;
END $$;
ROLLBACK;
