-- An SIE job step that fails the same way on every try is stopped at once.
--
-- The worker hands every failed step to record_sie_job_failure, which backs
-- off and claims the job again, up to 32 times (20260928095627). That is
-- right for a failure that may pass on a retry, and wrong for one that
-- cannot: a voucher chunk refused because one of its vouchers has the source
-- series and number of a posted imported verifikat of the same fiscal year
-- (journal_import_source_owned_idx, or import_sie_chunk's own check of the
-- same identity) is refused again on every claim. One import in production
-- was claimed every few minutes on that refusal and then shown as a
-- technical error (2026-11-16).
--
-- stop_sie_import_job ends such a run under the worker's lease and attempt
-- (lock_sie_execution, as record_sie_job_failure), with the reason the worker
-- gives, the way sweep_stalled_sie_import_jobs (20261109171500) stops a job:
--
--   * a job that has booked nothing (an import in its prepare or vouchers
--     phase with no verifikat of its batch) ends as failed and gives its
--     fiscal year back, as fail_sie_preparation does: the file can be
--     imported again;
--   * a job that has booked verifikat is paused with no automatic attempt
--     (next_attempt_at = 'infinity') and keeps its hold:
--     request_sie_import_undo refuses a failed job, so failing it would leave
--     posted verifikat no Ångra can reach. Ångra and Fortsätt re-arm it as
--     before.
--
-- Returns the outcome, 'failed' or 'paused'. New function only: nothing that
-- exists changes, and code deployed before this migration never calls it.

CREATE FUNCTION public.stop_sie_import_job(p_company_id uuid, p_import_id uuid,
  p_worker_id uuid, p_attempt integer, p_reason text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'A stop reason is required' USING ERRCODE = '22023';
  END IF;
  v_job := public.lock_sie_execution(p_company_id, p_import_id, p_worker_id, p_attempt);
  -- Booked nothing: what the stall sweep may fail.
  IF v_job.job_kind = 'import' AND v_job.job_phase IN ('prepare','vouchers')
     AND NOT EXISTS (SELECT 1 FROM public.journal_entries e WHERE e.import_batch_id = v_job.id) THEN
    UPDATE public.sie_imports SET job_state = 'failed', status = 'failed',
      consecutive_failures = consecutive_failures + 1,
      error_message = left(btrim(p_reason) || ' Inga verifikationer bokfördes.', 2000),
      worker_id = NULL, lease_until = NULL, job_attempt = job_attempt + 1, next_attempt_at = NULL
      WHERE id = p_import_id;
    UPDATE public.fiscal_periods SET import_hold = NULL
      WHERE id = v_job.fiscal_period_id AND company_id = v_job.company_id AND import_hold = p_import_id;
    RETURN 'failed';
  END IF;
  UPDATE public.sie_imports SET job_state = 'paused',
    consecutive_failures = consecutive_failures + 1,
    error_message = left(btrim(p_reason) || ' Tryck Ångra import för att ta bort det som bokfördes.', 2000),
    worker_id = NULL, lease_until = NULL, job_attempt = job_attempt + 1,
    next_attempt_at = 'infinity'::timestamptz
    WHERE id = p_import_id;
  RETURN 'paused';
END;
$$;
REVOKE ALL ON FUNCTION public.stop_sie_import_job(uuid, uuid, uuid, integer, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.stop_sie_import_job(uuid, uuid, uuid, integer, text) TO service_role;
