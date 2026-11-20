-- cron_runs: one row per run of a scheduled job.
-- pg-test: tests/pg/cron-runs.pg.test.ts
--
-- A scheduled job that the platform kills at its maxDuration leaves nothing
-- behind: no result, no log line, no alert. Jobs have been killed that way
-- (the payment status cron at its 300 s limit, and several others).
-- Each was found by reading the platform's request metrics afterwards, which
-- keep 30 days and nothing about what the run did. A job that stops being
-- called at all looks the same from the inside: nothing.
--
-- So the cron wrapper (lib/api/with-cron-context.ts) writes a row when a run
-- starts and closes it when the run ends. A row that stays 'running' past its
-- limit is a run the platform killed; a schedule with no row for longer than
-- its period is a job that is not being called. The watch job
-- (lib/cron/watch.ts, /api/health/cron-runs/cron) closes the first as
-- 'timed_out', records the second as 'missed', and mails the team one digest
-- of every problem row it has not reported yet.
--
--   status     meaning
--   running    started, not finished yet (or killed: see timed_out)
--   ok         the handler answered below 400
--   failed     the handler threw or answered 400 or above
--   timed_out  still running past limit_ms plus a minute: the platform killed it.
--              A run that finishes after all (self-hosted has no platform
--              limit) overwrites it with its own answer.
--   missed     the schedule's period passed without a run (written by the watch job)
--   expected   the watch job's first sight of a scheduled job that has no
--              row yet (a new job, or the first pass after this migration):
--              the moment its missed clock starts. Not a run.
--
-- alerted_at is the report claim: the watch job sets it with
-- UPDATE ... WHERE alerted_at IS NULL RETURNING before it mails, so a problem
-- is reported once however many runs see it, and a mail that fails clears it
-- again. Rows are operational, not accounting records: the watch job deletes
-- them after 45 days.
--
-- Not tenant data: a run serves every company, so there is no company_id.
-- Access: service role only. RLS on with no policies and no grants for anon
-- or authenticated, like peppol_alerts.
--
-- failed_pg_cron_runs() gives the same watch job the database's own
-- scheduler (pg_cron: update-overdue-supplier-invoices and
-- redact-expired-invoice-delivery-pii). Nothing read cron.job_run_details
-- before: the overdue job failed on every run from 2026-08-29 to 2026-09-24
-- (20260924204244) and nobody was told.

CREATE TABLE public.cron_runs (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  path        text NOT NULL,
  operation   text NOT NULL,
  status      text NOT NULL DEFAULT 'running' CHECK (status IN (
                'running',
                'ok',
                'failed',
                'timed_out',
                'missed',
                'expected'
              )),
  started_at  timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms integer CHECK (duration_ms IS NULL OR duration_ms >= 0),
  limit_ms    integer CHECK (limit_ms IS NULL OR limit_ms > 0),
  http_status integer,
  summary     jsonb,
  error       text,
  request_id  text,
  alerted_at  timestamptz,
  CONSTRAINT cron_runs_running_is_open
    CHECK ((status = 'running') = (finished_at IS NULL))
);

COMMENT ON TABLE public.cron_runs IS
  'One row = one run of a scheduled job, written by withCronContext at start and closed at the end. Still running past limit_ms: the platform killed it (the watch job closes it as timed_out). missed: the schedule passed without a run. alerted_at is the watch job''s report claim. Kept 45 days. Service role only.';

-- The newest runs of one job: the watch job's "when did it last run" and the 30-day report.
CREATE INDEX idx_cron_runs_path_started
  ON public.cron_runs (path, started_at DESC);

-- Runs still open: the watch job reads them on every pass.
CREATE INDEX idx_cron_runs_running
  ON public.cron_runs (started_at)
  WHERE status = 'running';

-- Rows past the retention: the watch job deletes them by age on every pass.
CREATE INDEX idx_cron_runs_started
  ON public.cron_runs (started_at);

-- A failed run of the database's scheduler is copied in once, however many
-- watch passes see it: the second insert of the same failure is refused.
CREATE UNIQUE INDEX uq_cron_runs_pg_cron_failure
  ON public.cron_runs (path, started_at)
  WHERE operation = 'pg_cron';

-- Problems nobody has been told about yet.
CREATE INDEX idx_cron_runs_unreported
  ON public.cron_runs (started_at)
  WHERE status IN ('failed', 'timed_out', 'missed') AND alerted_at IS NULL;

ALTER TABLE public.cron_runs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.cron_runs FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.cron_runs TO service_role;
-- no-grant: authenticated on public.cron_runs (service-role only: written by the cron wrapper, read by the watch job)
-- no-grant: anon on public.cron_runs (service-role only: written by the cron wrapper, read by the watch job)

-- ---------------------------------------------------------------------------
-- The newest row of each of the given paths, for the watch job's "is this
-- job still being called": one read for the whole schedule, each path an
-- index lookup (idx_cron_runs_path_started). A path with no row at all is
-- left out of the answer. SECURITY INVOKER: the caller needs its own SELECT
-- on cron_runs, which only the service role has.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.cron_latest_runs(p_paths text[])
RETURNS TABLE (path text, last_started_at timestamptz)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT p.path, newest.started_at
  FROM unnest(p_paths) AS p(path)
  CROSS JOIN LATERAL (
    SELECT r.started_at
    FROM public.cron_runs r
    WHERE r.path = p.path
    ORDER BY r.started_at DESC
    LIMIT 1
  ) AS newest
$$;

COMMENT ON FUNCTION public.cron_latest_runs(text[]) IS
  'Newest cron_runs.started_at for each given path; a path with no row is left out. Read by the cron watch job (lib/cron/watch.ts). Service role only.';

REVOKE ALL ON FUNCTION public.cron_latest_runs(text[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cron_latest_runs(text[]) TO service_role;

-- ---------------------------------------------------------------------------
-- Runs of the database's own scheduler that did not succeed.
--
-- One row per pg_cron job with a run since p_since whose status is not
-- 'succeeded' ('failed', or 'starting'/'running' that never ended is left
-- out: a run in flight is not a failure). SECURITY DEFINER because the cron
-- schema is not reachable by the API roles; it returns job names, counts and
-- the scheduler's own error text, nothing of any company. Empty where
-- pg_cron is not installed.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.failed_pg_cron_runs(p_since timestamptz)
RETURNS TABLE (jobname text, failed_runs bigint, last_failed_at timestamptz, last_message text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF to_regclass('cron.job_run_details') IS NULL OR to_regclass('cron.job') IS NULL THEN
    RETURN;
  END IF;
  RETURN QUERY EXECUTE $q$
    SELECT coalesce(j.jobname, 'job ' || j.jobid::text)::text,
           count(*)::bigint,
           max(d.start_time),
           (array_agg(left(d.return_message, 500) ORDER BY d.start_time DESC))[1]::text
    FROM cron.job_run_details d
    JOIN cron.job j ON j.jobid = d.jobid
    WHERE d.start_time >= $1
      AND d.status = 'failed'
    GROUP BY 1
    ORDER BY 1
  $q$ USING p_since;
END;
$$;

COMMENT ON FUNCTION public.failed_pg_cron_runs(timestamptz) IS
  'pg_cron jobs with a failed run since p_since: name, count, newest failure and its message. Read by the cron watch job (lib/cron/watch.ts). Empty where pg_cron is not installed. Service role only.';

REVOKE ALL ON FUNCTION public.failed_pg_cron_runs(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.failed_pg_cron_runs(timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
