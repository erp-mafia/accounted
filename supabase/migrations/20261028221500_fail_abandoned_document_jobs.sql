-- A document job whose worker died during its last attempt stayed 'running'
-- for good (#115). claim_document_jobs and claim_document_job_for take over a
-- stale running job only while attempts < max_attempts, so a job killed on
-- attempt 5 matched no claim and no sweep: nobody failed it, nothing reported
-- it, and the document stayed unread. enqueue_document_job re-queues only a
-- done or failed job, so the dead row also blocked a fresh read of the same
-- step.
--
-- fail_abandoned_document_jobs settles exactly those rows: running, out of
-- attempts, and locked longer than the claims' own ten-minute takeover window
-- (a live worker is never that old: the cron's maxDuration is five minutes).
-- They become 'failed' with a reason, the lock is cleared, and the rows are
-- returned so the worker can report them (runDocumentJobs calls this before
-- each claim and logs the ids as an error). A failed row is what the last
-- attempt's own catch would have written, so enqueue_document_job can queue
-- the step again.
--
-- No data change here: rows already stuck heal on the first worker run after
-- deploy. The function is the only new object; no table changes. Proven in
-- tests/pg/document-jobs-abandoned.pg.test.ts.

CREATE FUNCTION public.fail_abandoned_document_jobs(p_now timestamptz DEFAULT now())
RETURNS TABLE (
  id          uuid,
  company_id  uuid,
  document_id uuid,
  kind        text,
  attempts    int
)
LANGUAGE sql
SECURITY INVOKER
SET search_path = public
AS $$
  UPDATE public.document_jobs j
     SET status = 'failed',
         last_error = 'worker stopped during the last attempt',
         locked_at = NULL,
         locked_by = NULL
   WHERE j.status = 'running'
     AND j.attempts >= j.max_attempts
     AND j.locked_at < p_now - interval '10 minutes'
  RETURNING j.id, j.company_id, j.document_id, j.kind, j.attempts;
$$;
REVOKE EXECUTE ON FUNCTION public.fail_abandoned_document_jobs(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_abandoned_document_jobs(timestamptz) TO service_role;
COMMENT ON FUNCTION public.fail_abandoned_document_jobs(timestamptz) IS
  'Arkiv: fails document jobs left running on their last attempt by a worker that died (no claim takes them over), and returns them for the worker to report. Service role only.';

NOTIFY pgrst, 'reload schema';
