-- External call budget: a central, atomic count of paid upstream calls (first
-- user: TIC Lens company data, 3,000 calls per cycle), plus a shared response
-- cache so serverless instances stop re-buying the same answer.
-- pg-test: covered-by tests/pg/external-call-budget.pg.test.ts
--
-- Before this, nothing counted Lens spend centrally: each instance had a
-- 5-minute in-process cache and the quota ran out with calls nobody could
-- attribute. Every Lens call now reserves one unit here first
-- (reserve_external_call), under a purpose cap and a total cap, and is refused
-- once either is spent. The app degrades exactly as it does on TIC's own 429.
--
-- Everything is service-role only: RLS on, no member policies, the RPC is
-- SECURITY DEFINER and revoked from PUBLIC, anon and authenticated.

-- 1. Per cycle and purpose. The row with purpose '_total' carries the sum over
--    all purposes, so the total cap is checked under one row lock.
CREATE TABLE IF NOT EXISTS public.external_call_budget (
  provider    text NOT NULL CHECK (provider ~ '^[a-z][a-z0-9_]*$'),
  -- First day of the provider's quota cycle (TIC: the 22nd of each month).
  cycle_start date NOT NULL,
  purpose     text NOT NULL CHECK (purpose ~ '^_?[a-z][a-z0-9_]*$'),
  calls       integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, cycle_start, purpose)
);

COMMENT ON TABLE public.external_call_budget IS
  'Paid upstream calls per provider, quota cycle and purpose; purpose _total holds the cycle sum. Written only by reserve_external_call.';

ALTER TABLE public.external_call_budget ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.external_call_budget TO service_role;
-- no-grant: authenticated on public.external_call_budget (service-role only: written by reserve_external_call)
-- no-grant: anon on public.external_call_budget (service-role only: written by reserve_external_call)

-- 2. Per subject (an API key) and Stockholm day, for a per-key daily cap on
--    top of the purpose cap (the MCP company lookup).
CREATE TABLE IF NOT EXISTS public.external_call_subject_daily (
  provider   text NOT NULL,
  purpose    text NOT NULL,
  subject    text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
  day        date NOT NULL,
  calls      integer NOT NULL DEFAULT 0 CHECK (calls >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, purpose, subject, day)
);

COMMENT ON TABLE public.external_call_subject_daily IS
  'Paid upstream calls per provider, purpose, subject (API key id) and Stockholm day. Written only by reserve_external_call.';

ALTER TABLE public.external_call_subject_daily ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.external_call_subject_daily TO service_role;
-- no-grant: authenticated on public.external_call_subject_daily (service-role only: written by reserve_external_call)
-- no-grant: anon on public.external_call_subject_daily (service-role only: written by reserve_external_call)

-- 3. Shared response cache. Only successful upstream answers are stored, never
--    errors or rate-limit answers. The key is the SHA-256 of the request
--    (endpoint and parameters), so no org number or personnummer sits in a key
--    column; rows expire after a short TTL and are purged on write.
CREATE TABLE IF NOT EXISTS public.external_call_cache (
  provider   text NOT NULL,
  cache_key  text NOT NULL CHECK (cache_key ~ '^[0-9a-f]{64}$'),
  response   jsonb NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (provider, cache_key)
);

CREATE INDEX IF NOT EXISTS idx_external_call_cache_expires_at
  ON public.external_call_cache (expires_at);

COMMENT ON TABLE public.external_call_cache IS
  'Successful upstream responses shared across instances, keyed by SHA-256 of the request, expiring after a TTL.';

ALTER TABLE public.external_call_cache ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.external_call_cache TO service_role;
-- no-grant: authenticated on public.external_call_cache (service-role only: server-side cache)
-- no-grant: anon on public.external_call_cache (service-role only: server-side cache)

-- 4. Reserve one call. Increments the total, the purpose and (when given) the
--    subject's day counter, and checks each cap, all inside one exception
--    block: a refusal rolls every increment of this call back, so a refused
--    call costs nothing and two concurrent callers can never both pass the
--    last unit (the '_total' row is locked first by every caller, which also
--    fixes the lock order).
--
--    Caps: p_total_cap is required (the caller passes the total minus any
--    reserve held back for higher-priority purposes); p_purpose_cap and
--    p_subject_day_cap are skipped when NULL.
--    Returns {ok, scope?, total_calls?, purpose_calls?, subject_calls?}.
CREATE OR REPLACE FUNCTION public.reserve_external_call(
  p_provider         text,
  p_cycle_start      date,
  p_purpose          text,
  p_purpose_cap      integer,
  p_total_cap        integer,
  p_subject          text DEFAULT NULL,
  p_subject_day_cap  integer DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day           date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  v_total         integer;
  v_purpose_calls integer;
  v_subject_calls integer;
BEGIN
  IF p_purpose IS NULL OR p_purpose = '_total' THEN
    RAISE EXCEPTION 'reserve_external_call: purpose % is reserved', p_purpose USING ERRCODE = '22023';
  END IF;
  IF p_total_cap IS NULL THEN
    RAISE EXCEPTION 'reserve_external_call: p_total_cap is required' USING ERRCODE = '22023';
  END IF;

  BEGIN
    INSERT INTO public.external_call_budget (provider, cycle_start, purpose, calls)
    VALUES (p_provider, p_cycle_start, '_total', 1)
    ON CONFLICT (provider, cycle_start, purpose)
    DO UPDATE SET calls = external_call_budget.calls + 1, updated_at = now()
    RETURNING calls INTO v_total;

    IF v_total > p_total_cap THEN
      RAISE EXCEPTION 'total' USING ERRCODE = 'EB001';
    END IF;

    INSERT INTO public.external_call_budget (provider, cycle_start, purpose, calls)
    VALUES (p_provider, p_cycle_start, p_purpose, 1)
    ON CONFLICT (provider, cycle_start, purpose)
    DO UPDATE SET calls = external_call_budget.calls + 1, updated_at = now()
    RETURNING calls INTO v_purpose_calls;

    IF p_purpose_cap IS NOT NULL AND v_purpose_calls > p_purpose_cap THEN
      RAISE EXCEPTION 'purpose' USING ERRCODE = 'EB001';
    END IF;

    IF p_subject IS NOT NULL AND p_subject_day_cap IS NOT NULL THEN
      INSERT INTO public.external_call_subject_daily (provider, purpose, subject, day, calls)
      VALUES (p_provider, p_purpose, p_subject, v_day, 1)
      ON CONFLICT (provider, purpose, subject, day)
      DO UPDATE SET calls = external_call_subject_daily.calls + 1, updated_at = now()
      RETURNING calls INTO v_subject_calls;

      IF v_subject_calls > p_subject_day_cap THEN
        RAISE EXCEPTION 'subject' USING ERRCODE = 'EB001';
      END IF;
    END IF;
  EXCEPTION WHEN SQLSTATE 'EB001' THEN
    RETURN jsonb_build_object('ok', false, 'scope', SQLERRM);
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'total_calls', v_total,
    'purpose_calls', v_purpose_calls,
    'subject_calls', v_subject_calls
  );
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_external_call(text, date, text, integer, integer, text, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.reserve_external_call(text, date, text, integer, integer, text, integer) TO service_role;

NOTIFY pgrst, 'reload schema';
