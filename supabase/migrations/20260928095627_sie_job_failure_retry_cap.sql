-- record_sie_job_failure: stop retrying a SIE job after 32 consecutive failures.
--
-- The body from 20260911140515_sie_import_job_backbone.sql always set a new
-- next_attempt_at, and claim_sie_import_job reclaims every unfinished job
-- whose next_attempt_at has passed. A job whose failure is deterministic (a
-- sealed chunk that can never commit, because its payload hash is fixed) was
-- therefore reclaimed every hour for good: one production import failed 152
-- times in six days, each time with the same unbalanced IB entry and an alert.
--
-- From the 32nd consecutive failure the job stays paused with its error and no
-- automatic attempt: next_attempt_at = 'infinity', which the claim filter
-- (next_attempt_at <= clock_timestamp()) never reaches. The backoff below
-- (15 s, doubling to the one-hour ceiling at the ninth failure) puts the 32nd
-- failure about 24 hours after the first, so a job that fails through a
-- transient outage of up to a day still finishes on its own, while a job that
-- can never succeed goes quiet after a day instead of never.
--
-- Nothing else re-arms it except the user: Fortsätt (resume_sie_import_job)
-- and Ångra (request_sie_import_undo) both set next_attempt_at = NULL. They
-- keep the counter, so after the cap each press buys one attempt and a repeat
-- of the same failure pauses the job again at once. import_sie_chunk resets
-- the counter on every committed chunk, so the cap counts failures without
-- progress, never the length of a long import.
--
-- Signature, SECURITY DEFINER, search_path and grants are unchanged.

CREATE OR REPLACE FUNCTION public.record_sie_job_failure(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_error text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  -- consecutive_failures on the right-hand side is the value before this failure.
  UPDATE public.sie_imports SET consecutive_failures = consecutive_failures + 1,
    job_state = CASE WHEN consecutive_failures >= 2 THEN 'paused' ELSE 'reconciling' END,
    error_message = left(p_error, 2000), worker_id = NULL, lease_until = NULL,
    job_attempt = job_attempt + 1,
    next_attempt_at = CASE WHEN consecutive_failures + 1 >= 32 THEN 'infinity'::timestamptz
      ELSE clock_timestamp() + make_interval(secs => least(3600, 15 * power(2, least(consecutive_failures, 8)))::integer) END
    WHERE id = p_import_id;
END;
$$;
REVOKE ALL ON FUNCTION public.record_sie_job_failure(uuid, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_sie_job_failure(uuid, uuid, uuid, integer, text) TO service_role;
