-- prune_delivery_events: the events cleanup cron's 30-day pass over
-- delivery events, without reading the agent telemetry.
--
-- The cron used to delete through PostgREST with
--   created_at < now() - 30 days AND event_type NOT LIKE 'mcp.%' AND NOT LIKE 'agent.%'
-- Telemetry (mcp.*, agent.*) is kept 180 days, so that range holds every
-- telemetry row between 30 and 180 days old, and the scan read all of them
-- to find a day of delivery events: ~425k rows for ~7k on 2026-10-25, when
-- the 02:00 UTC run hit PostgREST's 8 s statement timeout. It grows with
-- agent traffic.
--
-- Here the delivery event types are found by skipping through
-- idx_event_log_type_created (a loose index scan, about fifty probes), and
-- the delete reads only those types' rows past the cutoff. Batched by
-- p_limit; the cron calls it until a batch comes back short.

CREATE OR REPLACE FUNCTION public.prune_delivery_events(p_before timestamptz, p_limit integer DEFAULT 20000)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_types text[];
  v_count integer;
BEGIN
  IF p_before IS NULL OR p_before > now() - interval '1 day' THEN
    RAISE EXCEPTION 'p_before must be at least a day in the past' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100000 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 100000' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  WITH RECURSIVE t AS (
    (SELECT e.event_type FROM public.event_log e ORDER BY e.event_type LIMIT 1)
    UNION ALL
    SELECT (SELECT e.event_type FROM public.event_log e WHERE e.event_type > t.event_type ORDER BY e.event_type LIMIT 1)
      FROM t
     WHERE t.event_type IS NOT NULL
  )
  SELECT array_agg(t.event_type) INTO v_types
    FROM t
   WHERE t.event_type IS NOT NULL
     AND t.event_type NOT LIKE 'mcp.%'
     AND t.event_type NOT LIKE 'agent.%';

  IF v_types IS NULL THEN
    RETURN 0;
  END IF;

  DELETE FROM public.event_log
   WHERE sequence IN (
     SELECT e.sequence
       FROM public.event_log e
      WHERE e.event_type = ANY (v_types)
        AND e.created_at < p_before
      LIMIT p_limit
   );
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.prune_delivery_events(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prune_delivery_events(timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.prune_delivery_events(timestamptz, integer) IS
  'Deletes up to p_limit event_log delivery events (every type but mcp.* and agent.*) older than p_before, reading only those types through idx_event_log_type_created. Service role only (the events cleanup cron).';

NOTIFY pgrst, 'reload schema';
