-- Event outbox, step E3: what the dispatcher needs to run a deferred delivery,
-- and the reconciliation of the deliveries it runs.
--
--   claim_event_deliveries     restated from 20261017120100 with one more
--                              column, inline_result: the dispatcher runs a
--                              claimed delivery's consumer only when it says
--                              'deferred' (20261018110000) and marks every
--                              other one done, as in shadow mode.
--   event_outbox_async_counts  per hour, consumer and event type: the deferred
--                              deliveries enqueued, processed, open, retrying
--                              and dead, and the latency from the event to the
--                              finished delivery. The switch-on check and the
--                              watch for a consumer flipped to the outbox.
--
-- A RETURNS TABLE gains a column only by DROP and CREATE; both run in this
-- migration's transaction, so no caller sees the function missing. The grants
-- are restated with it.
--
-- pg-test: tests/pg/event-outbox-async.pg.test.ts, tests/pg/event-outbox.pg.test.ts,
--          tests/pg/definer-function-grants.pg.test.ts

-- =============================================================================
-- 1. claim_event_deliveries
-- =============================================================================
-- As in 20261017120100: leases up to p_limit due deliveries, oldest event
-- first: pending ones whose backoff has passed, and claimed ones whose lease
-- ran out. Each claim counts as an attempt. A delivery whose lease ran out on
-- its last attempt (p_max_attempts) goes dead here instead of being claimed
-- again. done and dead are never claimed. SKIP LOCKED: two dispatchers never
-- claim one delivery at the same moment. Answers the claimed deliveries with
-- their event and, new, their inline_result.

DROP FUNCTION public.claim_event_deliveries(integer, integer, integer);

CREATE FUNCTION public.claim_event_deliveries(
  p_limit integer,
  p_lease_seconds integer,
  p_max_attempts integer DEFAULT 8
)
RETURNS TABLE (
  outbox_id bigint,
  consumer_id text,
  attempts integer,
  lease_until timestamptz,
  company_id uuid,
  event_type text,
  payload jsonb,
  created_at timestamptz,
  inline_result text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 1000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 1000' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 5 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 5 and 3600' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 100 THEN
    RAISE EXCEPTION 'p_max_attempts must be between 1 and 100' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH due AS (
    SELECT d.outbox_id AS due_outbox_id, d.consumer_id AS due_consumer_id
      FROM public.event_deliveries d
     WHERE d.status IN ('pending', 'claimed')
       AND (d.lease_until IS NULL OR d.lease_until <= now())
     ORDER BY d.outbox_id, d.consumer_id
     LIMIT p_limit
     FOR UPDATE SKIP LOCKED
  ),
  leased AS (
    UPDATE public.event_deliveries d
       SET status = CASE
             WHEN d.status = 'claimed' AND d.attempts >= p_max_attempts THEN 'dead'
             ELSE 'claimed'
           END,
           attempts = CASE
             WHEN d.status = 'claimed' AND d.attempts >= p_max_attempts THEN d.attempts
             ELSE d.attempts + 1
           END,
           lease_until = CASE
             WHEN d.status = 'claimed' AND d.attempts >= p_max_attempts THEN NULL
             ELSE now() + make_interval(secs => p_lease_seconds)
           END,
           last_error = CASE
             WHEN d.status = 'claimed' AND d.attempts >= p_max_attempts THEN 'lease expired on the last attempt'
             ELSE d.last_error
           END
      FROM due
     WHERE d.outbox_id = due.due_outbox_id
       AND d.consumer_id = due.due_consumer_id
    RETURNING d.outbox_id AS l_outbox_id, d.consumer_id AS l_consumer_id, d.status AS l_status,
              d.attempts AS l_attempts, d.lease_until AS l_lease_until, d.inline_result AS l_inline_result
  )
  SELECT l.l_outbox_id, l.l_consumer_id, l.l_attempts, l.l_lease_until,
         o.company_id, o.event_type, o.payload, o.created_at, l.l_inline_result
    FROM leased l
    JOIN public.event_outbox o ON o.id = l.l_outbox_id
   WHERE l.l_status = 'claimed'
   ORDER BY l.l_outbox_id, l.l_consumer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_event_deliveries(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_event_deliveries(integer, integer, integer) TO service_role;

-- =============================================================================
-- 2. event_outbox_async_counts
-- =============================================================================
-- The reconciliation of the deliveries the dispatcher runs (inline_result
-- 'deferred'). Per hour (of the event), consumer and event type since
-- p_since:
--   enqueued   deliveries deferred to the outbox
--   processed  done: the dispatcher ran the consumer and it succeeded
--   open       pending or claimed: still owed
--   retrying   open after at least one failed attempt (last_error set)
--   dead       gave up after the attempts ran out
--   retried    processed, but not on the first attempt
--   max_attempts, and the latency of the processed ones from the event to
--   done (p50, p95, max, in seconds), and the age of the oldest open one.
-- A consumer runs healthy from the outbox when every hour has enqueued =
-- processed + open + dead, dead = 0, the open ones are minutes old at most
-- (oldest_open_seconds) and the latency stays within the accepted minute.
-- Read-only.

CREATE OR REPLACE FUNCTION public.event_outbox_async_counts(
  p_since timestamptz,
  p_until timestamptz DEFAULT now()
)
RETURNS TABLE (
  hour timestamptz,
  consumer_id text,
  event_type text,
  enqueued bigint,
  processed bigint,
  open bigint,
  retrying bigint,
  dead bigint,
  retried bigint,
  max_attempts integer,
  latency_p50_seconds numeric,
  latency_p95_seconds numeric,
  latency_max_seconds numeric,
  oldest_open_seconds numeric
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT date_trunc('hour', o.created_at) AS hour,
         d.consumer_id,
         o.event_type,
         count(*) AS enqueued,
         count(*) FILTER (WHERE d.status = 'done') AS processed,
         count(*) FILTER (WHERE d.status IN ('pending', 'claimed')) AS open,
         count(*) FILTER (WHERE d.status IN ('pending', 'claimed') AND d.last_error IS NOT NULL) AS retrying,
         count(*) FILTER (WHERE d.status = 'dead') AS dead,
         count(*) FILTER (WHERE d.status = 'done' AND d.attempts > 1) AS retried,
         max(d.attempts) AS max_attempts,
         round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM d.done_at - o.created_at))
                  FILTER (WHERE d.status = 'done'))::numeric, 1) AS latency_p50_seconds,
         round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM d.done_at - o.created_at))
                  FILTER (WHERE d.status = 'done'))::numeric, 1) AS latency_p95_seconds,
         round(max(extract(epoch FROM d.done_at - o.created_at)) FILTER (WHERE d.status = 'done'), 1)
           AS latency_max_seconds,
         round(max(extract(epoch FROM now() - o.created_at)) FILTER (WHERE d.status IN ('pending', 'claimed')), 1)
           AS oldest_open_seconds
    FROM public.event_outbox o
    JOIN public.event_deliveries d ON d.outbox_id = o.id
   WHERE d.inline_result = 'deferred'
     AND o.created_at >= p_since
     AND o.created_at < p_until
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, 3
$$;

REVOKE ALL ON FUNCTION public.event_outbox_async_counts(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_outbox_async_counts(timestamptz, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
