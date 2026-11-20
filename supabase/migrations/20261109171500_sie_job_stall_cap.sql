-- SIE jobs that stall are counted, bounded and stopped (accounted#115).
--
-- record_sie_job_failure counts a step that throws, and stops a job at 32
-- consecutive failures (20260928095627). Two other ways a run can end were
-- counted by nothing:
--
--   * a stall: the run yields (yield_sie_import_job) or its lease lapses (the
--     route killed at 300 s, a crashed function) without the job moving on.
--     Neither touches consecutive_failures, and claim_sie_import_job takes a
--     lapsed lease over, so such a job was claimed every minute for good;
--   * an actor who can no longer write: claim_sie_import_job only claims a job
--     whose execution actor is still a non-viewer member, so a job whose actor
--     left the company (or became a viewer) was skipped for good, silently,
--     still running on screen, holding fiscal_periods.import_hold so its year
--     could not be locked or closed.
--
-- The claim now stamps claim_mark: the job's progress (phase, chunk counters,
-- preparation position, checkpoint rows) and the attempt it was claimed at.
-- Every step that moves a job on changes the progress, and every RPC that
-- ends a run on purpose (a recorded failure, Fortsätt, Ångra, a stop) raises
-- job_attempt; yield_sie_import_job and a lapsed lease do neither. So a job
-- that is unleased, due, and still carries the mark of its last claim stalled.
--
-- sweep_stalled_sie_import_jobs, called by the worker cron before it claims,
-- finds those jobs and the ones whose actor can no longer write, and counts
-- each as a failure in consecutive_failures with a reason on the row:
--
--   * a stall below the cap backs off exactly as record_sie_job_failure does
--     (15 s doubling to one hour), so 32 stalls take about a day;
--   * a stall at the cap, and an actor who can no longer write at once, stop
--     the job. A job that has booked nothing (an import in its prepare or
--     vouchers phase with no verifikat of its batch) ends as failed and
--     releases its import_hold, as fail_sie_preparation does: the year can be
--     closed and the file imported again. A job that has booked verifikat is
--     paused with no automatic attempt (next_attempt_at = 'infinity') and
--     keeps its hold: request_sie_import_undo refuses a failed job, so failing
--     it would leave posted verifikat no Ångra can reach, in a year that could
--     then be locked over them. Fortsätt and Ångra re-arm it as before; for an
--     actor who left, an owner or administrator takes it over (both RPCs
--     already make the person who presses them the actor).
--
-- The sweep returns one row per job it counted, which the worker logs as an
-- error with the job's context. lock_sie_execution is unchanged: the sweep
-- never writes through a lease, takes the job row before the company lock
-- without waiting (as the claim does), so it never races a writer, and raises
-- job_attempt on every job it counts, which fences out a worker whose lease
-- lapsed while it was still running.
--
-- record_sie_job_failure, yield_sie_import_job and lock_sie_execution are not
-- changed. The new column is nullable and only the claim and the sweep read
-- it, so code deployed before or after this migration keeps working.

ALTER TABLE public.sie_imports ADD COLUMN claim_mark text;

COMMENT ON COLUMN public.sie_imports.claim_mark IS
  'Progress and attempt of the job at its last claim (sie_job_progress || ''@'' || job_attempt); sweep_stalled_sie_import_jobs counts a run that left it unchanged as a stall.';

-- How far the job has come. Each step that moves a job on changes one of
-- these: the phase, chunks_done (vouchers, repair undo), prepared_through
-- (preparation) or the checkpoint rows (preparation chunks, metadata,
-- finalize and undo receipts). Internal: only the claim and the sweep call it.
CREATE FUNCTION public.sie_job_progress(p_job public.sie_imports) RETURNS text
LANGUAGE sql STABLE SET search_path = public AS $$
  SELECT concat_ws('/', (p_job).job_phase, (p_job).chunks_done, (p_job).prepared_through,
    (SELECT count(*) FROM public.sie_import_chunks c WHERE c.import_id = (p_job).id),
    (SELECT count(*) FROM public.sie_import_chunks c WHERE c.import_id = (p_job).id AND c.state = 'completed'))
$$;
REVOKE ALL ON FUNCTION public.sie_job_progress(public.sie_imports) FROM PUBLIC, anon, authenticated, service_role;

-- Unchanged from 20260911140515 except the claim_mark stamp.
CREATE OR REPLACE FUNCTION public.claim_sie_import_job(p_worker_id uuid, p_import_id uuid DEFAULT NULL)
RETURNS public.sie_imports LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_job public.sie_imports;
BEGIN
  IF p_worker_id IS NULL THEN RAISE EXCEPTION 'Worker identity required'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-platform-claim', 0));
  IF (SELECT count(*) FROM public.sie_imports WHERE lease_until > clock_timestamp()
      AND job_state NOT IN ('completed','undone','failed')) >= 2 THEN RETURN NULL; END IF;
  SELECT * INTO v_job FROM public.sie_imports
    WHERE job_state NOT IN ('completed','undone','failed')
      AND (p_import_id IS NULL OR id = p_import_id)
      AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      AND (next_attempt_at IS NULL OR next_attempt_at <= clock_timestamp())
      AND EXISTS (SELECT 1 FROM public.company_members m WHERE m.company_id = sie_imports.company_id
        AND m.user_id = coalesce(sie_imports.execution_actor_id,sie_imports.user_id) AND m.role <> 'viewer')
      AND EXISTS (SELECT 1 FROM public.fiscal_periods p WHERE p.id = sie_imports.fiscal_period_id
        AND p.company_id = sie_imports.company_id AND p.import_hold = sie_imports.id)
    ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  -- Nonblocking company acquisition avoids deadlocks with a committing worker.
  IF NOT pg_try_advisory_xact_lock(hashtextextended('sie-company:' || v_job.company_id::text, 0)) THEN RETURN NULL; END IF;
  -- The claim moves nothing sie_job_progress reads, so the mark is the
  -- progress as the run starts, with the attempt this claim gives it.
  UPDATE public.sie_imports SET worker_id = p_worker_id,
    lease_until = clock_timestamp() + interval '2 minutes', job_attempt = job_attempt + 1,
    job_state = CASE job_phase WHEN 'prepare' THEN 'preparing' WHEN 'undo' THEN 'undoing'
      WHEN 'finalize' THEN 'finalizing' ELSE 'running' END,
    claim_mark = public.sie_job_progress(v_job) || '@' || (v_job.job_attempt + 1)
    WHERE id = v_job.id RETURNING * INTO v_job;
  RETURN v_job;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_sie_import_job(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_sie_import_job(uuid, uuid) TO service_role;

CREATE FUNCTION public.sweep_stalled_sie_import_jobs() RETURNS SETOF jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_job public.sie_imports;
  v_seen uuid[] := '{}';
  v_actor_left boolean;
  v_reason text;
  v_stop boolean;
  v_failable boolean;
  v_outcome text;
  v_message text;
BEGIN
  -- Serialised with the claims, so a sweep and a claim never judge the same
  -- job at once. Both are short and never write ledger rows.
  PERFORM pg_advisory_xact_lock(hashtextextended('sie-platform-claim', 0));
  LOOP
    -- The jobs a claim would consider (unfinished, unleased, due, holding
    -- their year), narrowed to the two cases this sweep counts.
    SELECT j.* INTO v_job FROM public.sie_imports j
      WHERE j.job_state NOT IN ('completed','undone','failed')
        AND NOT (j.id = ANY(v_seen))
        AND (j.lease_until IS NULL OR j.lease_until <= clock_timestamp())
        AND (j.next_attempt_at IS NULL OR j.next_attempt_at <= clock_timestamp())
        AND EXISTS (SELECT 1 FROM public.fiscal_periods p WHERE p.id = j.fiscal_period_id
          AND p.company_id = j.company_id AND p.import_hold = j.id)
        AND (NOT EXISTS (SELECT 1 FROM public.company_members m WHERE m.company_id = j.company_id
              AND m.user_id = coalesce(j.execution_actor_id, j.user_id) AND m.role <> 'viewer')
          OR j.claim_mark = (public.sie_job_progress(j) || '@' || j.job_attempt))
      ORDER BY j.created_at FOR UPDATE OF j SKIP LOCKED LIMIT 1;
    EXIT WHEN NOT FOUND;
    v_seen := v_seen || v_job.id;
    -- Row first, then the company without waiting, as the claim does: a
    -- writer holds the company lock for its whole step, so a job in the
    -- middle of one is left alone and judged again on the next sweep.
    CONTINUE WHEN NOT pg_try_advisory_xact_lock(hashtextextended('sie-company:' || v_job.company_id::text, 0));

    v_actor_left := NOT EXISTS (SELECT 1 FROM public.company_members m WHERE m.company_id = v_job.company_id
      AND m.user_id = coalesce(v_job.execution_actor_id, v_job.user_id) AND m.role <> 'viewer');
    IF v_actor_left THEN
      v_reason := 'actor_not_member';
      v_stop := true;
    ELSE
      v_reason := CASE WHEN v_job.worker_id IS NULL THEN 'yielded_without_progress' ELSE 'lease_lapsed' END;
      -- consecutive_failures is the value before this one, as in record_sie_job_failure.
      v_stop := v_job.consecutive_failures + 1 >= 32;
    END IF;
    -- Booked nothing: what fail_sie_preparation may fail, extended to the
    -- vouchers phase before its first chunk commits (preparation only adds
    -- accounts and dimensions; renames and VAT defaults come in finalize).
    v_failable := v_job.job_kind = 'import' AND v_job.job_phase IN ('prepare','vouchers')
      AND NOT EXISTS (SELECT 1 FROM public.journal_entries e WHERE e.import_batch_id = v_job.id);

    IF v_stop AND v_failable THEN
      v_outcome := 'failed';
      v_message := CASE WHEN v_actor_left
        THEN 'Personen som startade importen har inte längre skrivbehörighet i företaget.'
        ELSE 'Importen kom inte vidare efter upprepade försök och har avbrutits.' END
        || ' Inga verifikationer bokfördes. Starta en ny import.';
      UPDATE public.sie_imports SET job_state = 'failed', status = 'failed',
        consecutive_failures = consecutive_failures + 1, error_message = v_message,
        worker_id = NULL, lease_until = NULL, job_attempt = job_attempt + 1, next_attempt_at = NULL
        WHERE id = v_job.id RETURNING * INTO v_job;
      UPDATE public.fiscal_periods SET import_hold = NULL
        WHERE id = v_job.fiscal_period_id AND company_id = v_job.company_id AND import_hold = v_job.id;
    ELSIF v_stop THEN
      v_outcome := 'paused';
      v_message := CASE WHEN v_actor_left
        THEN 'Personen som startade importen har inte längre skrivbehörighet i företaget. En ägare eller administratör kan trycka Fortsätt eller Ångra import.'
        ELSE 'Importen kom inte vidare efter upprepade försök och har pausats. Tryck Fortsätt för ett nytt försök eller Ångra import.' END;
      UPDATE public.sie_imports SET job_state = 'paused',
        consecutive_failures = consecutive_failures + 1, error_message = v_message,
        worker_id = NULL, lease_until = NULL, job_attempt = job_attempt + 1,
        next_attempt_at = 'infinity'::timestamptz
        WHERE id = v_job.id RETURNING * INTO v_job;
    ELSE
      v_outcome := 'retrying';
      v_message := 'Importen kom inte vidare vid senaste försöket och försöker igen automatiskt.';
      -- record_sie_job_failure's state and backoff, so a stall and a thrown
      -- step spend the same budget.
      UPDATE public.sie_imports SET consecutive_failures = consecutive_failures + 1,
        job_state = CASE WHEN consecutive_failures >= 2 THEN 'paused' ELSE 'reconciling' END,
        error_message = v_message, worker_id = NULL, lease_until = NULL,
        job_attempt = job_attempt + 1,
        next_attempt_at = clock_timestamp() + make_interval(secs => least(3600, 15 * power(2, least(consecutive_failures, 8)))::integer)
        WHERE id = v_job.id RETURNING * INTO v_job;
    END IF;

    RETURN NEXT jsonb_build_object('importId', v_job.id, 'companyId', v_job.company_id,
      'jobKind', v_job.job_kind, 'phase', v_job.job_phase, 'state', v_job.job_state,
      'outcome', v_outcome, 'reason', v_reason, 'consecutiveFailures', v_job.consecutive_failures,
      'attempt', v_job.job_attempt, 'holdReleased', v_outcome = 'failed');
  END LOOP;
END;
$$;
REVOKE ALL ON FUNCTION public.sweep_stalled_sie_import_jobs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stalled_sie_import_jobs() TO service_role;

NOTIFY pgrst, 'reload schema';
