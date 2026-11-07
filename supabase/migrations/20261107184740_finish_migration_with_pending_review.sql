-- Finishing the execution is not approval of its unresolved records.
ALTER TABLE public.migration_jobs ADD COLUMN review_deferred_at timestamptz;
CREATE INDEX migration_jobs_saved_reviews ON public.migration_jobs(company_id,review_deferred_at DESC)
  WHERE review_deferred_at IS NOT NULL;
CREATE FUNCTION public.finish_provider_migration_with_review(p_job_id uuid,p_company_id uuid,p_user_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs; remaining integer;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id
    AND role IN ('owner','admin','member')) THEN RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  SELECT count(*) INTO remaining FROM migration_job_chunks WHERE job_id=j.id AND state='needs_attention';
  IF j.state='completed' AND j.review_deferred_at IS NOT NULL THEN RETURN remaining; END IF;
  IF j.state<>'needs_attention' OR j.phase<>'completed' OR j.error_code IS NOT NULL OR remaining=0
    OR EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state IN ('pending','imported','linked','planned'))
    THEN RAISE EXCEPTION 'MIGRATION_REVIEW_NOT_FINISHABLE'; END IF;
  UPDATE migration_jobs SET state='completed',review_deferred_at=now(),
    worker_id=NULL,lease_until=NULL,next_attempt_at=NULL WHERE id=j.id;
  INSERT INTO audit_log(company_id,user_id,actor_id,actor_type,action,table_name,record_id,old_state,new_state,description)
    VALUES(p_company_id,p_user_id,p_user_id,'user','UPDATE','migration_jobs',j.id,
      jsonb_build_object('state',j.state),jsonb_build_object('state','completed','remaining_review',remaining),
      'Import execution finished; unresolved source records retained for later review');
  RETURN remaining;
END $$;
REVOKE ALL ON FUNCTION public.finish_provider_migration_with_review(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.finish_provider_migration_with_review(uuid,uuid,uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.retry_provider_migration_job(p_job_id uuid,p_company_id uuid,p_user_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE j public.migration_jobs;
BEGIN
  IF NOT EXISTS(SELECT 1 FROM company_members WHERE company_id=p_company_id AND user_id=p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'MIGRATION_WRITE_FORBIDDEN'; END IF;
  SELECT * INTO STRICT j FROM migration_jobs WHERE id=p_job_id AND company_id=p_company_id FOR UPDATE;
  IF j.state NOT IN ('needs_attention','retry_wait') AND NOT(j.state='completed' AND j.review_deferred_at IS NOT NULL
    AND EXISTS(SELECT 1 FROM migration_job_chunks WHERE job_id=j.id AND state='needs_attention')) THEN RETURN; END IF;
  UPDATE migration_job_chunks SET state=CASE error_phase WHEN 'link' THEN 'imported' WHEN 'reconcile' THEN 'linked' WHEN 'settle' THEN 'planned' ELSE 'pending' END,
    error_code=NULL,error_phase=NULL WHERE job_id=j.id AND state='needs_attention';
  UPDATE migration_jobs SET user_id=p_user_id,state='queued',phase=CASE WHEN phase='discover' THEN 'discover' ELSE 'import' END,
    worker_id=NULL,lease_until=NULL,next_attempt_at=NULL,failures=0,error_code=NULL WHERE id=j.id;
END $$;
NOTIFY pgrst,'reload schema';
