-- Agent telemetry rollup: an anonymous, long-lived copy of the mcp.* and
-- agent.* rows in event_log.
--
-- The events cleanup cron deletes agent telemetry after 180 days
-- (.compliance/ropa.yaml, mcp.telemetry). Logging started 2026-05-06, so from
-- 2026-11-02 the record of how agents use the system stops growing past six
-- months: which tools they call, where they fail, which skills they load,
-- what they do next. These tables keep that record as daily counts with no
-- company, user, API key, session id, free text, arguments or results in
-- them, so they are anonymous and can be kept without a retention limit.
--
-- What is kept, per UTC day:
--   agent_telemetry_daily         counts per event type, tool/skill/resource
--                                 kind, client family, actor type, outcome
--                                 and error code, plus how many agents (API
--                                 keys) and companies the count spans and
--                                 latency p50/p95
--   agent_tool_transitions_daily  which tool call followed which for the same
--                                 agent, and how each one went ('(start)' for
--                                 the first call after 30 minutes of silence)
--   agent_telemetry_rollup_days   the days already rolled up, so a day is
--                                 counted exactly once
--
-- Anything a caller can put free text into is reduced before it lands:
-- client markers to a fixed family list (the marker is only charset-checked
-- and customers put their own labels in it), tool names the server did not
-- recognise to '(unknown_tool)', own skills to '(own)', error codes outside
-- the SCREAMING_SNAKE registry shape to '(other)'.
--
-- The rollup runs from the events cleanup cron before it purges, and the cron
-- skips the telemetry purge when the rollup fails, so a day is never deleted
-- before it has been counted. The backfill of the days already logged is the
-- next migration.

-- =============================================================================
-- 1. Tables (service role only: written by the rollup, read for analysis)
-- =============================================================================

CREATE TABLE public.agent_telemetry_daily (
  day            date    NOT NULL,
  event_type     text    NOT NULL,
  name           text    NOT NULL,
  client         text    NOT NULL,
  actor_type     text    NOT NULL,
  outcome        text    NOT NULL,
  error_kind     text    NOT NULL,
  error_code     text    NOT NULL,
  events         integer NOT NULL,
  actors         integer NOT NULL,
  companies      integer NOT NULL,
  latency_ms_p50 integer,
  latency_ms_p95 integer,
  PRIMARY KEY (day, event_type, name, client, actor_type, outcome, error_kind, error_code)
);

COMMENT ON TABLE public.agent_telemetry_daily IS
  'Anonymous daily counts of agent telemetry (event_log mcp.*/agent.*), kept after the raw rows are purged. No company, user, key, session or free text. Written only by rollup_agent_telemetry.';

CREATE TABLE public.agent_tool_transitions_daily (
  day          date    NOT NULL,
  client       text    NOT NULL,
  from_tool    text    NOT NULL,
  from_outcome text    NOT NULL,
  to_tool      text    NOT NULL,
  to_outcome   text    NOT NULL,
  transitions  integer NOT NULL,
  actors       integer NOT NULL,
  companies    integer NOT NULL,
  PRIMARY KEY (day, client, from_tool, from_outcome, to_tool, to_outcome)
);

COMMENT ON TABLE public.agent_tool_transitions_daily IS
  'Anonymous daily counts of which MCP tool call followed which for the same agent (from_tool ''(start)'' after 30 minutes of silence). Written only by rollup_agent_telemetry.';

CREATE TABLE public.agent_telemetry_rollup_days (
  day       date        PRIMARY KEY,
  rolled_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.agent_telemetry_rollup_days IS
  'UTC days already rolled into agent_telemetry_daily and agent_tool_transitions_daily; a day is rolled once.';

ALTER TABLE public.agent_telemetry_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_tool_transitions_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.agent_telemetry_rollup_days ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_telemetry_daily TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_tool_transitions_daily TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.agent_telemetry_rollup_days TO service_role;
-- no-grant: authenticated on public.agent_telemetry_daily (service-role only: platform analytics, no company data to show a member)
-- no-grant: anon on public.agent_telemetry_daily (service-role only: platform analytics)
-- no-grant: authenticated on public.agent_tool_transitions_daily (service-role only: platform analytics, no company data to show a member)
-- no-grant: anon on public.agent_tool_transitions_daily (service-role only: platform analytics)
-- no-grant: authenticated on public.agent_telemetry_rollup_days (service-role only: rollup bookkeeping)
-- no-grant: anon on public.agent_telemetry_rollup_days (service-role only: rollup bookkeeping)

-- =============================================================================
-- 2. Reducers: free text in, a bounded label out
-- =============================================================================

-- The client marker (X-Accounted-Client, X-Gnubok-Client, ?client=) is only
-- checked against a charset, and customers put their own labels in it
-- (names, run ids). Only the public agent products are kept by name.
CREATE OR REPLACE FUNCTION public.agent_client_family(p_client text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_client IS NULL OR p_client = '' THEN '(none)'
    WHEN lower(p_client) ~ '^claude[-_]?code' THEN 'claude-code'
    WHEN lower(p_client) ~ '^claude[-_]?desktop' THEN 'claude-desktop'
    WHEN lower(p_client) ~ '^claude' THEN 'claude'
    WHEN lower(p_client) ~ '^chatgpt' THEN 'chatgpt'
    WHEN lower(p_client) ~ '^codex' THEN 'codex'
    WHEN lower(p_client) ~ '^cursor' THEN 'cursor'
    WHEN lower(p_client) ~ '^gem[ie]ni' THEN 'gemini'
    WHEN lower(p_client) ~ '^grok' THEN 'grok'
    WHEN lower(p_client) ~ '^openclaw' THEN 'openclaw'
    WHEN lower(p_client) ~ '^opencode' THEN 'opencode'
    WHEN lower(p_client) ~ '^accounted-cli' THEN 'accounted-cli'
    WHEN lower(p_client) ~ '^(vscode|zed|antigravity|hermes|base44)' THEN substring(lower(p_client) FROM '^(vscode|zed|antigravity|hermes|base44)')
    ELSE 'other'
  END
$$;

-- A tool the server recognised keeps its registry name; a name an agent
-- invented (errorKind unknown_tool) is free text and is only counted.
CREATE OR REPLACE FUNCTION public.agent_telemetry_tool_label(p_tool text, p_error_kind text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = ''
AS $$
  SELECT CASE
    WHEN p_error_kind = 'unknown_tool' THEN '(unknown_tool)'
    WHEN p_tool IS NULL OR p_tool = '' THEN ''
    WHEN p_tool ~ '^[a-z][a-z0-9_.]{0,79}$' THEN p_tool
    ELSE '(other)'
  END
$$;

REVOKE ALL ON FUNCTION public.agent_client_family(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.agent_telemetry_tool_label(text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.agent_client_family(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.agent_telemetry_tool_label(text, text) TO service_role;

-- =============================================================================
-- 3. rollup_agent_telemetry
-- =============================================================================

-- Rolls up to p_max_days whole UTC days, oldest first, that start at or after
-- p_since, end before today and are not rolled yet. Returns how many days it
-- rolled (0 when nothing is due). A day that began before p_since may already
-- have lost rows to the purge, and the ledger would freeze that undercount,
-- so the caller passes a p_since no earlier than the last purge's cutoff.
CREATE OR REPLACE FUNCTION public.rollup_agent_telemetry(p_since timestamptz, p_max_days integer DEFAULT 1)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_first date;
  v_last  date := (now() AT TIME ZONE 'UTC')::date - 1;
  v_days  date[];
  v_from  timestamptz;
  v_to    timestamptz;
BEGIN
  IF p_since IS NULL THEN
    RAISE EXCEPTION 'p_since is required' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_max_days IS NULL OR p_max_days < 1 OR p_max_days > 400 THEN
    RAISE EXCEPTION 'p_max_days must be between 1 and 400' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  -- Two runs at once would pick the same days and fail on the primary key.
  PERFORM pg_advisory_xact_lock(hashtext('public.rollup_agent_telemetry'));

  v_first := (p_since AT TIME ZONE 'UTC')::date;
  IF (v_first::timestamp AT TIME ZONE 'UTC') < p_since THEN
    v_first := v_first + 1;
  END IF;

  SELECT array_agg(d.day ORDER BY d.day) INTO v_days
    FROM (
      SELECT g::date AS day
        FROM generate_series(v_first::timestamp, v_last::timestamp, interval '1 day') g
       WHERE NOT EXISTS (SELECT 1 FROM public.agent_telemetry_rollup_days r WHERE r.day = g::date)
       ORDER BY 1
       LIMIT p_max_days
    ) d;

  IF v_days IS NULL THEN
    RETURN 0;
  END IF;

  v_from := v_days[1]::timestamp AT TIME ZONE 'UTC';
  v_to := (v_days[array_length(v_days, 1)] + 1)::timestamp AT TIME ZONE 'UTC';

  INSERT INTO public.agent_telemetry_daily (
    day, event_type, name, client, actor_type, outcome, error_kind, error_code,
    events, actors, companies, latency_ms_p50, latency_ms_p95
  )
  SELECT m.day, m.event_type, m.name, m.client, m.actor_type, m.outcome, m.error_kind, m.error_code,
         count(*), count(DISTINCT m.actor_id), count(DISTINCT m.company_id),
         percentile_disc(0.5) WITHIN GROUP (ORDER BY m.latency_ms),
         percentile_disc(0.95) WITHIN GROUP (ORDER BY m.latency_ms)
    FROM (
      SELECT (e.created_at AT TIME ZONE 'UTC')::date AS day,
             e.event_type,
             e.company_id,
             nullif(e.data->>'actorId', '') AS actor_id,
             CASE e.event_type
               WHEN 'mcp.tool_called' THEN public.agent_telemetry_tool_label(e.data->>'tool', e.data->>'errorKind')
               WHEN 'mcp.skill_loaded' THEN
                 CASE WHEN e.data->>'tier' = 'own' THEN '(own)'
                      WHEN e.data->>'slug' ~ '^[a-z0-9][a-z0-9/_-]{0,79}$' THEN e.data->>'slug'
                      ELSE '(other)' END
               WHEN 'mcp.workflow_started' THEN
                 CASE WHEN e.data->>'slug' ~ '^[a-z0-9][a-z0-9/_-]{0,79}$' THEN e.data->>'slug' ELSE '(other)' END
               WHEN 'mcp.resource_read' THEN coalesce(substring(e.data->>'kind' FROM '^[a-z_]{1,32}$'), '(other)')
               -- Feedback names a tool in its own words; only the product's
               -- tool namespaces are kept.
               WHEN 'agent.feedback' THEN
                 CASE WHEN coalesce(e.data->>'toolName', '') = '' THEN ''
                      WHEN e.data->>'toolName' ~ '^(gnubok|accounted)_[a-z0-9_]{1,80}$' THEN e.data->>'toolName'
                      ELSE '(other)' END
               ELSE ''
             END AS name,
             public.agent_client_family(e.data->>'client') AS client,
             coalesce(substring(e.data->>'actorType' FROM '^[a-z_]{1,32}$'), '') AS actor_type,
             CASE
               WHEN e.event_type = 'agent.feedback' THEN coalesce(substring(e.data->>'sentiment' FROM '^[a-z_]{1,32}$'), '(other)')
               WHEN e.data->>'success' = 'true' THEN 'ok'
               WHEN e.data->>'success' = 'false' THEN 'error'
               ELSE ''
             END AS outcome,
             coalesce(substring(e.data->>'errorKind' FROM '^[a-z_]{1,40}$'), '') AS error_kind,
             CASE
               WHEN e.data->>'errorCode' IS NULL THEN ''
               WHEN e.data->>'errorCode' ~ '^[A-Z][A-Z0-9_]{0,63}$' THEN e.data->>'errorCode'
               ELSE '(other)'
             END AS error_code,
             CASE WHEN e.data->>'latencyMs' ~ '^[0-9]{1,9}$' THEN (e.data->>'latencyMs')::integer END AS latency_ms
        FROM public.event_log e
       WHERE e.created_at >= v_from
         AND e.created_at < v_to
         AND (e.event_type LIKE 'mcp.%' OR e.event_type LIKE 'agent.%')
    ) m
   WHERE m.day = ANY (v_days)
   GROUP BY 1, 2, 3, 4, 5, 6, 7, 8;

  -- Agents do not send Mcp-Session-Id (no prod call has carried one), so a
  -- session is inferred the usual way: the same agent (session id when there
  -- is one, else the API key), with more than 30 minutes of silence starting
  -- a new one. Calls from the day before are read so a session that crossed
  -- midnight keeps its real predecessor.
  INSERT INTO public.agent_tool_transitions_daily (
    day, client, from_tool, from_outcome, to_tool, to_outcome, transitions, actors, companies
  )
  SELECT t.day, t.client, t.from_tool, t.from_outcome, t.to_tool, t.to_outcome,
         count(*), count(DISTINCT t.agent), count(DISTINCT t.company_id)
    FROM (
      SELECT (c.created_at AT TIME ZONE 'UTC')::date AS day,
             c.agent,
             c.company_id,
             c.client,
             CASE WHEN lag(c.created_at) OVER w IS NULL OR c.created_at - lag(c.created_at) OVER w > interval '30 minutes'
                  THEN '(start)' ELSE lag(c.tool) OVER w END AS from_tool,
             CASE WHEN lag(c.created_at) OVER w IS NULL OR c.created_at - lag(c.created_at) OVER w > interval '30 minutes'
                  THEN '' ELSE lag(c.outcome) OVER w END AS from_outcome,
             c.tool AS to_tool,
             c.outcome AS to_outcome
        FROM (
          SELECT e.created_at,
                 e.sequence,
                 e.company_id,
                 coalesce(nullif(e.data->>'sessionId', ''), nullif(e.data->>'actorId', '')) AS agent,
                 public.agent_client_family(e.data->>'client') AS client,
                 public.agent_telemetry_tool_label(e.data->>'tool', e.data->>'errorKind') AS tool,
                 CASE WHEN e.data->>'success' = 'true' THEN 'ok' ELSE 'error' END AS outcome
            FROM public.event_log e
           WHERE e.event_type = 'mcp.tool_called'
             AND e.created_at >= v_from - interval '1 day'
             AND e.created_at < v_to
             AND coalesce(nullif(e.data->>'sessionId', ''), nullif(e.data->>'actorId', '')) IS NOT NULL
        ) c
      WINDOW w AS (PARTITION BY c.agent ORDER BY c.created_at, c.sequence)
    ) t
   WHERE t.day = ANY (v_days)
   GROUP BY 1, 2, 3, 4, 5, 6;

  INSERT INTO public.agent_telemetry_rollup_days (day)
  SELECT unnest(v_days);

  RETURN array_length(v_days, 1);
END;
$$;

REVOKE ALL ON FUNCTION public.rollup_agent_telemetry(timestamptz, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rollup_agent_telemetry(timestamptz, integer) TO service_role;

COMMENT ON FUNCTION public.rollup_agent_telemetry(timestamptz, integer) IS
  'Rolls whole UTC days of event_log agent telemetry (mcp.*, agent.*) into the anonymous daily tables, oldest first, each day once. Service role only (the events cleanup cron, before it purges).';

-- =============================================================================
-- 4. A day of telemetry is many rows; give the RPC the 30 s the SIE
--    chunk writer and the ledger build get instead of PostgREST's 8 s.
--    Restated from 20261023093900 with rollup_agent_telemetry added.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.pre_request_statement_timeout() RETURNS void LANGUAGE plpgsql AS $$
DECLARE v_path text := coalesce(current_setting('request.path', true), '');
BEGIN
  IF v_path ~ '/rpc/(import_sie_chunk|reconcile_sie_import|build_ledger_account_days|rollup_agent_telemetry)$' THEN
    PERFORM set_config('statement_timeout', '30s', true);
  END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';
