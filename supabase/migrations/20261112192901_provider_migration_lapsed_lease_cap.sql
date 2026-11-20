-- A register import whose worker is ended every time is counted and stopped.
-- pg-test: tests/pg/provider-migration-lapsed-lease.pg.test.ts
--
-- release_provider_migration_job counts a run that throws, and the worker
-- parks the job as needs_attention on the fifth failure in a row. A run the
-- platform ends (the route killed at its time limit, a crashed function)
-- never reaches the release: the job stays 'running' until its 5 minute lease
-- lapses, and claim_provider_migration_job (20260918141327) took a lapsed
-- lease over without counting anything. A job whose worker dies every time
-- was therefore claimed every five minutes for good, "running" on the
-- person's screen, and nobody was told. The SIE import worker got the same
-- rule in 20261109171500.
--
-- The claim now stamps claim_mark: where the job stood when it was claimed
-- (phase, register, page, and its records by state). A job found 'running'
-- with a lapsed lease was never released, so its worker was ended:
--
--   * still at its claim_mark, the run moved nothing. It is counted in
--     failures with error_code MIGRATION_LEASE_LAPSED. Below the cap the job
--     is claimed again as before; on the fifth in a row (failures was 4, the
--     cap the worker already parks a thrown failure at) it is parked as
--     needs_attention instead, and returned in that state so the worker can
--     report it once. The page shows "Importen behöver ses över" with
--     Fortsätt importen, and retry_provider_migration_job re-arms it.
--   * past its claim_mark, the run moved the job on before it was ended. That
--     is a deferral, like running out of time after a checkpoint: failures is
--     reset, as a clean release does.
--
-- A lease only lapses under a worker that is gone: every fenced RPC renews it
-- (lock_provider_migration_job), and each waits at most the worker's own
-- deadline. The worker that lost it is fenced out as before, by attempt.
--
-- The column is nullable and only this function reads it. A job claimed
-- before this migration has no mark, and NULL is distinct from any mark, so
-- its first lapsed lease reads as a run that moved the job: the count is
-- reset and the claim stamps a mark, and only the lapses after it are
-- counted. That is the safe side: a job is never parked for a lapse that may
-- have moved it on. Code deployed before or after keeps working: the worker
-- releases nothing for a job that is not 'running'.

ALTER TABLE public.migration_jobs ADD COLUMN claim_mark text;

COMMENT ON COLUMN public.migration_jobs.claim_mark IS
  'Where the job stood at its last claim (provider_migration_progress); a lapsed lease on a job still at its mark is counted as a failure by claim_provider_migration_job.';

-- How far the job has come: every step that moves it on changes the phase,
-- the register or page being read, or the state of at least one record.
-- Internal: only the claim calls it.
CREATE FUNCTION public.provider_migration_progress(p_job public.migration_jobs) RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
  SELECT concat_ws('/', (p_job).phase, (p_job).resource_index, (p_job).next_page,
    (SELECT coalesce(string_agg(c.state || ':' || c.n, ',' ORDER BY c.state), '')
       FROM (SELECT state, count(*) AS n FROM public.migration_job_chunks
              WHERE job_id = (p_job).id GROUP BY state) c))
$$;
REVOKE ALL ON FUNCTION public.provider_migration_progress(public.migration_jobs) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.provider_migration_progress(public.migration_jobs) TO service_role;

-- Unchanged from 20260918141327 except the lapsed-lease count and the mark.
CREATE OR REPLACE FUNCTION public.claim_provider_migration_job(p_worker_id uuid, p_job_id uuid DEFAULT NULL)
RETURNS public.migration_jobs LANGUAGE plpgsql SECURITY INVOKER SET search_path = public AS $$
DECLARE
  j public.migration_jobs;
  v_mark text;
  v_failures integer;
  v_error text;
BEGIN
  SELECT * INTO j FROM migration_jobs
    WHERE state IN ('queued','running','retry_wait') AND (p_job_id IS NULL OR id=p_job_id)
      AND (lease_until IS NULL OR lease_until < clock_timestamp())
      AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
    ORDER BY updated_at, id LIMIT 1 FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  v_mark := public.provider_migration_progress(j);
  v_failures := j.failures;
  v_error := j.error_code;
  -- Every release clears the lease, so a 'running' job that still has one
  -- (lapsed, or the select above would not have taken it) was never released.
  IF j.state = 'running' AND j.lease_until IS NOT NULL THEN
    IF j.claim_mark IS DISTINCT FROM v_mark THEN
      v_failures := 0;
      v_error := NULL;
    ELSIF j.failures >= 4 THEN
      UPDATE migration_jobs SET state='needs_attention', worker_id=NULL, lease_until=NULL, next_attempt_at=NULL,
        failures=failures+1, error_code='MIGRATION_LEASE_LAPSED'
        WHERE id=j.id RETURNING * INTO j;
      RETURN j;
    ELSE
      v_failures := j.failures + 1;
      v_error := 'MIGRATION_LEASE_LAPSED';
    END IF;
  END IF;
  UPDATE migration_jobs SET state='running', worker_id=p_worker_id, attempt=attempt+1,
    lease_until=clock_timestamp()+interval '5 minutes', next_attempt_at=NULL,
    failures=v_failures, error_code=v_error, claim_mark=v_mark
    WHERE id=j.id RETURNING * INTO j;
  RETURN j;
END $$;
REVOKE ALL ON FUNCTION public.claim_provider_migration_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_provider_migration_job(uuid, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
