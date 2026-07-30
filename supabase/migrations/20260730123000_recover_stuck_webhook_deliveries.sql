-- Migration: recover_stuck_webhook_deliveries
--
-- Issue #1257. The dispatcher's in_flight sweep used to be a PostgREST chain
-- in lib/webhooks/dispatcher.ts:
--
--   UPDATE webhook_deliveries
--      SET status = 'failed', next_attempt_at = now(),
--          error  = 'recovered_from_in_flight_timeout'
--    WHERE status = 'in_flight' AND updated_at < now() - 20s
--
-- Two defects, both fixed here plus in the TS caller:
--
-- 1. WHY THE WINDOW CHANGED. The old 20 s threshold (2x the 10 s receiver
--    timeout) was far shorter than one dispatch cycle: the cron claims 50 rows
--    and attempts them SERIALLY, and updated_at was stamped once at claim
--    time. From row 3 onward every row in a cycle was already past the
--    threshold before its own attempt began, so cycle N recovered and
--    re-claimed rows cycle N-1 was still working through: duplicate POSTs of
--    the same X-Gnubok-Delivery, and a terminal status decided by a race whose
--    loser was swallowed as a log.warn. The caller now derives the window from
--    a bounded cycle (CYCLE_BUDGET_MS 120 s + one request timeout + 30 s
--    slack, floored at the cron's 50-row batch = 160 s) and re-stamps
--    updated_at immediately before each row's own attempt, so no row a live
--    cycle owns can fall inside the window.
--
-- 2. WHY attempts IS CHARGED. The old sweep reset rows to 'failed' without
--    touching attempts, so a delivery caught in the recover/re-claim loop
--    could be re-POSTed well past MAX_ATTEMPTS and the ~87 h retry budget
--    stopped being an upper bound. A stall is an attempt that produced no
--    receiver acknowledgement, so it is charged like any other. PostgREST
--    cannot express `attempts = attempts + 1`, nor the conditional flip at the
--    cap, and a read-then-write loop in JS would reopen a TOCTOU against
--    enforce_webhook_delivery_immutability. Hence this function.
--
-- 3. WHY A ROW PAST THE CAP GOES TO 'dead'. Once attempts + 1 reaches
--    p_max_attempts the row has exhausted its budget and must reach a terminal
--    state instead of looping (BFNAR 2013:2 kap 8 § behandlingshistorik: every
--    delivery row reaches a terminal state). The end state is byte-identical in
--    shape to what the normal path writes at dispatcher.ts's
--    'attempts_exhausted' branch: status = 'dead', attempts = p_max_attempts,
--    error prefixed 'attempts_exhausted'. The suffix ':in_flight_timeout'
--    records that the last attempt stalled rather than returned. Unlike
--    markDead without an outcome, this branch does NOT null response_status /
--    response_body / response_headers and does NOT reset next_attempt_at: the
--    last recorded response is the only diagnostic left on an abandoned
--    attempt, and next_attempt_at is meaningless once terminal.
--
-- The BEFORE UPDATE immutability trigger is NOT weakened or bypassed: the
-- outer UPDATE keeps `status = 'in_flight'` in its own WHERE (not only in the
-- CTE) so that under READ COMMITTED a row that raced to delivered/dead between
-- scan and lock fails re-evaluation and is skipped entirely. The trigger
-- therefore never fires, and a mid-flight terminal flip cannot abort the sweep.
--
-- SECURITY DEFINER with an explicit service_role gate: the dispatcher runs
-- under createServiceClientNoCookies(), and nothing reachable by anon or
-- authenticated may re-arm another tenant's deliveries. Same shape as
-- 20260727100000_list_invoice_delivery_summaries_for_service.sql.

CREATE OR REPLACE FUNCTION public.recover_stuck_webhook_deliveries(
  p_stuck_before timestamptz,
  p_max_attempts int,
  p_now          timestamptz DEFAULT now()
)
RETURNS TABLE (id uuid, status text, attempts int)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'webhook delivery recovery requires a server-controlled service role'
      USING ERRCODE = '42501';
  END IF;

  IF p_stuck_before IS NULL THEN
    RAISE EXCEPTION 'p_stuck_before is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  IF p_max_attempts IS NULL OR p_max_attempts <= 0 THEN
    RAISE EXCEPTION 'p_max_attempts must be > 0; got %', p_max_attempts
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH stuck AS (
    SELECT wd.id
      FROM public.webhook_deliveries wd
     WHERE wd.status = 'in_flight'
       AND wd.updated_at < p_stuck_before
     FOR UPDATE SKIP LOCKED
  )
  UPDATE public.webhook_deliveries wd
     SET attempts = wd.attempts + 1,
         status = CASE WHEN wd.attempts + 1 >= p_max_attempts THEN 'dead' ELSE 'failed' END,
         next_attempt_at = CASE WHEN wd.attempts + 1 >= p_max_attempts
                                THEN wd.next_attempt_at ELSE p_now END,
         error = CASE WHEN wd.attempts + 1 >= p_max_attempts
                      THEN 'attempts_exhausted:in_flight_timeout'
                      ELSE 'recovered_from_in_flight_timeout' END
    FROM stuck
   WHERE wd.id = stuck.id
     AND wd.status = 'in_flight'
  RETURNING wd.id, wd.status, wd.attempts;
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stuck_webhook_deliveries(timestamptz, int, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stuck_webhook_deliveries(timestamptz, int, timestamptz)
  TO service_role;

COMMENT ON FUNCTION public.recover_stuck_webhook_deliveries(timestamptz, int, timestamptz) IS
  'Service-role sweep of webhook_deliveries rows abandoned in in_flight by a killed dispatch cycle. Charges one attempt per stall and lands a row past p_max_attempts on the same dead/attempts-exhausted terminal state the normal retry path produces. Skips rows that raced to a terminal status, so the immutability trigger never fires.';

-- Hygiene from #1257: no existing index serves this sweep.
-- idx_webhook_deliveries_due is partial on status IN ('pending','failed'),
-- which structurally excludes in_flight. No CONCURRENTLY: migrations run
-- inside a transaction, and the table is tiny (tens of rows in production).
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_in_flight_updated
  ON public.webhook_deliveries (updated_at)
  WHERE status = 'in_flight';

NOTIFY pgrst, 'reload schema';
