-- Per-USER minute + day counters for the in-app AI agent LLM endpoints
-- (/api/agent/invoke, /api/agent/onboarding/stream, /api/agent/composer).
--
-- Backstops against unbounded Bedrock spend:
--   1) A logged-in user (or compromised session) loop-firing chat turns.
--   2) Reload-spamming /onboarding/agent (each reload re-runs 2 LLM calls).
-- Limits are deliberately GENEROUS — a normal heavy user never hits them; the
-- cap only catches runaway loops / reload spam. Keyed per-user (not per-company)
-- because the abuse vector is a single session, and several users can share a
-- company. Atomic check-and-increment under INSERT…ON CONFLICT row locking —
-- same shape as check_and_increment_inbox_quota. No Upstash dependency.

CREATE TABLE IF NOT EXISTS public.agent_rate_counters (
  user_id      uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  window_kind  text NOT NULL CHECK (window_kind IN ('minute','day')),
  window_key   text NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, window_kind, window_key)
);

ALTER TABLE public.agent_rate_counters ENABLE ROW LEVEL SECURITY;

-- No user access — writes go exclusively through the SECURITY DEFINER fn below.
-- Explicit USING(false) policies state the intent (CLAUDE.md migration rule 1).
CREATE POLICY agent_rate_counters_no_select ON public.agent_rate_counters FOR SELECT USING (false);
CREATE POLICY agent_rate_counters_no_insert ON public.agent_rate_counters FOR INSERT WITH CHECK (false);
CREATE POLICY agent_rate_counters_no_update ON public.agent_rate_counters FOR UPDATE USING (false);
CREATE POLICY agent_rate_counters_no_delete ON public.agent_rate_counters FOR DELETE USING (false);

CREATE TRIGGER update_agent_rate_counters_updated_at
  BEFORE UPDATE ON public.agent_rate_counters
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE OR REPLACE FUNCTION public.check_and_increment_agent_quota(
  p_user_id    uuid,
  p_minute_max integer,
  p_day_max    integer
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minute_key   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  v_day_key      text := to_char(now() AT TIME ZONE 'Europe/Stockholm', 'YYYY-MM-DD');
  v_minute_count integer;
  v_day_count    integer;
BEGIN
  -- 1) Minute window — burst guard.
  INSERT INTO public.agent_rate_counters (user_id, window_kind, window_key, count)
  VALUES (p_user_id, 'minute', v_minute_key, 1)
  ON CONFLICT (user_id, window_kind, window_key)
  DO UPDATE SET count = agent_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  -- 2) Day window — slow-drip backstop (only checked once minute passes).
  INSERT INTO public.agent_rate_counters (user_id, window_kind, window_key, count)
  VALUES (p_user_id, 'day', v_day_key, 1)
  ON CONFLICT (user_id, window_kind, window_key)
  DO UPDATE SET count = agent_rate_counters.count + 1, updated_at = now()
  RETURNING count INTO v_day_count;

  IF v_day_count > p_day_max THEN
    -- Roll both counters back: the request didn't go through.
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'day' AND window_key = v_day_key;
    UPDATE public.agent_rate_counters SET count = count - 1
      WHERE user_id = p_user_id AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'day', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

NOTIFY pgrst, 'reload schema';
