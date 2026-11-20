-- Event outbox, step E2: the functions over event_outbox and event_deliveries
-- (20261017120000). All service role only: SECURITY DEFINER with the search
-- path pinned, EXECUTE revoked from PUBLIC, anon and authenticated.
--
--   enqueue_event               one call: the outbox row and one delivery per consumer
--   claim_event_deliveries      lease due deliveries (FOR UPDATE SKIP LOCKED)
--   complete_event_deliveries   finish claimed deliveries as done
--   fail_event_delivery         back to pending after a backoff, or dead
--   prune_event_outbox          delete finished events after 7 days, dead ones after 30
--   event_outbox_shadow_counts  shadow reconciliation per hour, consumer and event type
--
-- A finish call names the delivery and the attempt its claim returned: the
-- attempt count is the fencing token. A dispatcher whose lease ran out and
-- whose delivery was claimed again (attempts moved on) finishes nothing.
--
-- pg-test: tests/pg/event-outbox.pg.test.ts, tests/pg/definer-function-grants.pg.test.ts

-- =============================================================================
-- 1. enqueue_event
-- =============================================================================
-- Writes the event and one pending delivery per distinct consumer id in one
-- transaction, so an event is never in the outbox without its deliveries.
-- Answers the outbox id, or NULL when nothing was written: no consumer ids,
-- or an event with this dedupe_key is already there. p_inline_results maps a
-- consumer id to its inline_result (shadow mode); ids it does not name get
-- NULL. A company id that is not a company is stored as NULL rather than
-- refusing the event: the outbox must not lose an event over its tag.

CREATE OR REPLACE FUNCTION public.enqueue_event(
  p_event_type text,
  p_company_id uuid,
  p_payload jsonb,
  p_consumer_ids text[],
  p_dedupe_key text DEFAULT NULL,
  p_inline_results jsonb DEFAULT NULL
)
RETURNS bigint
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id bigint;
BEGIN
  IF p_consumer_ids IS NULL OR cardinality(p_consumer_ids) = 0 THEN
    RETURN NULL;
  END IF;
  IF p_payload IS NULL THEN
    RAISE EXCEPTION 'p_payload is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  INSERT INTO public.event_outbox (company_id, event_type, payload, dedupe_key)
  VALUES (
    (SELECT c.id FROM public.companies c WHERE c.id = p_company_id),
    p_event_type,
    p_payload,
    p_dedupe_key
  )
  ON CONFLICT (dedupe_key) DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO public.event_deliveries (outbox_id, consumer_id, inline_result)
  SELECT v_id, c.consumer_id, p_inline_results ->> c.consumer_id
    FROM (SELECT DISTINCT unnest(p_consumer_ids) AS consumer_id) c;

  RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.enqueue_event(text, uuid, jsonb, text[], text, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.enqueue_event(text, uuid, jsonb, text[], text, jsonb) TO service_role;

-- =============================================================================
-- 2. claim_event_deliveries
-- =============================================================================
-- Leases up to p_limit due deliveries, oldest event first: pending ones whose
-- backoff has passed, and claimed ones whose lease ran out (the dispatcher
-- that held them died or stalled). Each claim counts as an attempt. A
-- delivery whose lease ran out on its last attempt (p_max_attempts) goes dead
-- here instead of being claimed again. done and dead are never claimed.
-- SKIP LOCKED: two dispatchers (the cron and a kick) never claim one delivery
-- at the same moment. Answers the claimed deliveries with their event.

CREATE OR REPLACE FUNCTION public.claim_event_deliveries(
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
  created_at timestamptz
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
              d.attempts AS l_attempts, d.lease_until AS l_lease_until
  )
  SELECT l.l_outbox_id, l.l_consumer_id, l.l_attempts, l.l_lease_until,
         o.company_id, o.event_type, o.payload, o.created_at
    FROM leased l
    JOIN public.event_outbox o ON o.id = l.l_outbox_id
   WHERE l.l_status = 'claimed'
   ORDER BY l.l_outbox_id, l.l_consumer_id;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_event_deliveries(integer, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_event_deliveries(integer, integer, integer) TO service_role;

-- =============================================================================
-- 3. complete_event_deliveries
-- =============================================================================
-- Marks claimed deliveries done, each only with the attempt its claim
-- returned (parallel arrays: outbox id, consumer id, attempt). Answers how
-- many were finished; a delivery claimed again since, or no longer claimed,
-- is left as it is.

CREATE OR REPLACE FUNCTION public.complete_event_deliveries(
  p_outbox_ids bigint[],
  p_consumer_ids text[],
  p_attempts integer[]
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF cardinality(p_outbox_ids) IS DISTINCT FROM cardinality(p_consumer_ids)
     OR cardinality(p_outbox_ids) IS DISTINCT FROM cardinality(p_attempts) THEN
    RAISE EXCEPTION 'p_outbox_ids, p_consumer_ids and p_attempts must have the same length'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF cardinality(p_outbox_ids) > 1000 THEN
    RAISE EXCEPTION 'at most 1000 deliveries per call' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.event_deliveries d
     SET status = 'done',
         done_at = now(),
         lease_until = NULL,
         last_error = NULL
    FROM unnest(p_outbox_ids, p_consumer_ids, p_attempts) AS k(outbox_id, consumer_id, attempt)
   WHERE d.outbox_id = k.outbox_id
     AND d.consumer_id = k.consumer_id
     AND d.status = 'claimed'
     AND d.attempts = k.attempt;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.complete_event_deliveries(bigint[], text[], integer[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.complete_event_deliveries(bigint[], text[], integer[]) TO service_role;

-- =============================================================================
-- 4. fail_event_delivery
-- =============================================================================
-- A claimed delivery whose consumer failed: pending again, not due before
-- p_retry_after_seconds, or dead once it has used p_max_attempts attempts.
-- Only with the attempt its claim returned. Answers the new status, or
-- 'lease_lost' when the delivery is no longer this claim's (nothing changes).

CREATE OR REPLACE FUNCTION public.fail_event_delivery(
  p_outbox_id bigint,
  p_consumer_id text,
  p_attempt integer,
  p_error text,
  p_retry_after_seconds integer DEFAULT 60,
  p_max_attempts integer DEFAULT 8
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_status text;
BEGIN
  IF p_retry_after_seconds IS NULL OR p_retry_after_seconds < 0 OR p_retry_after_seconds > 86400 THEN
    RAISE EXCEPTION 'p_retry_after_seconds must be between 0 and 86400' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_max_attempts IS NULL OR p_max_attempts < 1 OR p_max_attempts > 100 THEN
    RAISE EXCEPTION 'p_max_attempts must be between 1 and 100' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  UPDATE public.event_deliveries d
     SET status = CASE WHEN d.attempts >= p_max_attempts THEN 'dead' ELSE 'pending' END,
         lease_until = CASE
           WHEN d.attempts >= p_max_attempts THEN NULL
           ELSE now() + make_interval(secs => p_retry_after_seconds)
         END,
         last_error = left(COALESCE(p_error, 'failed'), 1000)
   WHERE d.outbox_id = p_outbox_id
     AND d.consumer_id = p_consumer_id
     AND d.status = 'claimed'
     AND d.attempts = p_attempt
  RETURNING d.status INTO v_status;

  RETURN COALESCE(v_status, 'lease_lost');
END;
$$;

REVOKE ALL ON FUNCTION public.fail_event_delivery(bigint, text, integer, text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fail_event_delivery(bigint, text, integer, text, integer, integer) TO service_role;

-- =============================================================================
-- 5. prune_event_outbox
-- =============================================================================
-- Deletes, oldest first and at most p_limit at a time, the events (and with
-- them their deliveries) created before the retention: 7 days when every
-- delivery is done, 30 days when every delivery is done or dead. An event
-- with a pending or claimed delivery is work still owed and is kept. Called
-- daily by /api/events/cleanup/cron. Answers how many events it deleted.

CREATE OR REPLACE FUNCTION public.prune_event_outbox(
  p_done_retention interval DEFAULT interval '7 days',
  p_dead_retention interval DEFAULT interval '30 days',
  p_limit integer DEFAULT 10000
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF p_done_retention IS NULL OR p_done_retention < interval '1 hour'
     OR p_dead_retention IS NULL OR p_dead_retention < p_done_retention THEN
    RAISE EXCEPTION 'retention must be at least one hour, dead at least as long as done'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  DELETE FROM public.event_outbox o
   WHERE o.id IN (
     SELECT x.id
       FROM public.event_outbox x
      WHERE x.created_at < now() - p_done_retention
        AND NOT EXISTS (
          SELECT 1 FROM public.event_deliveries d
           WHERE d.outbox_id = x.id
             AND (d.status IN ('pending', 'claimed')
                  OR (d.status = 'dead' AND x.created_at >= now() - p_dead_retention))
        )
      ORDER BY x.created_at
      LIMIT p_limit
   );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_event_outbox(interval, interval, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_event_outbox(interval, interval, integer) TO service_role;

-- =============================================================================
-- 6. event_outbox_shadow_counts
-- =============================================================================
-- The shadow reconciliation, the switch-on check for E3. Per hour (of the
-- event), consumer and event type since p_since: how many deliveries were
-- enqueued, how many times the same consumer ran inline (ok or failed), how
-- many it was not subscribed for, and where the deliveries are now. A
-- consumer is ready to be flipped to async when, over the window, every
-- delivery had an inline run (enqueued = inline_ok + inline_failed,
-- not_subscribed = 0), nothing is dead and nothing older than a few minutes
-- is open; the bus logs the inline runs that got no delivery at all ('event
-- outbox shadow enqueue failed', 'event consumer ran inline outside the
-- consumer index'), which must be zero for the same window. Read-only.

CREATE OR REPLACE FUNCTION public.event_outbox_shadow_counts(
  p_since timestamptz,
  p_until timestamptz DEFAULT now()
)
RETURNS TABLE (
  hour timestamptz,
  consumer_id text,
  event_type text,
  enqueued bigint,
  inline_ok bigint,
  inline_failed bigint,
  not_subscribed bigint,
  done bigint,
  open bigint,
  dead bigint,
  max_attempts integer
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
         count(*) FILTER (WHERE d.inline_result = 'ok') AS inline_ok,
         count(*) FILTER (WHERE d.inline_result = 'failed') AS inline_failed,
         count(*) FILTER (WHERE d.inline_result = 'not_subscribed') AS not_subscribed,
         count(*) FILTER (WHERE d.status = 'done') AS done,
         count(*) FILTER (WHERE d.status IN ('pending', 'claimed')) AS open,
         count(*) FILTER (WHERE d.status = 'dead') AS dead,
         max(d.attempts) AS max_attempts
    FROM public.event_outbox o
    JOIN public.event_deliveries d ON d.outbox_id = o.id
   WHERE o.created_at >= p_since
     AND o.created_at < p_until
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, 3
$$;

REVOKE ALL ON FUNCTION public.event_outbox_shadow_counts(timestamptz, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.event_outbox_shadow_counts(timestamptz, timestamptz) TO service_role;

NOTIFY pgrst, 'reload schema';
