-- Connector proxy: per-connection ledger, global upstream budget, key limits.
--
-- WS3 PR5. The hosted proxy under /api/connect/* brokers Enable Banking (and,
-- next, Skatteverket) for self-hosted instances. Tokens stay on the instance;
-- the proxy holds NO usable credential per customer. What it needs hosted-side
-- is only: (1) a way to recognise a connection an instance obtained through
-- its own key so it cannot use one it did not create or one belonging to
-- another instance, (2) a global rate budget so all connector traffic plus
-- hosted stays under Enable Banking's shared quota (Annex 1 §5: 20 rps /
-- 300 rpm / 10 000 per hour), and (3) per-key entitlement limits (e.g. one
-- bank connection per company) that the package sells.
--
-- Everything here is service-role only (RLS on, no policies); the validate and
-- reserve RPCs are SECURITY DEFINER and REVOKEd from PUBLIC/anon/authenticated.

-- 1. Per-key limits (the sellable package shape). Defaulted so existing keys
--    get sane values without a data backfill.
ALTER TABLE public.connector_keys
  ADD COLUMN limits jsonb NOT NULL DEFAULT
    '{"bank_connections_per_company": 1, "skv_connections_per_company": 1, "sync_min_interval_s": 0}'::jsonb;

-- 2. Connection ledger: one row per bank/SKV connection an instance holds,
--    identified by the SHA-256 of the upstream handle (EB session id, SKV
--    access token). The handle value itself is NEVER stored: the row proves
--    "this key created this connection for this company_ref" and nothing more.
CREATE TABLE public.connector_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key_id  uuid NOT NULL REFERENCES public.connector_keys(id) ON DELETE CASCADE,
  service           text NOT NULL CHECK (service IN ('bank', 'skatteverket')),
  -- The instance's own company id, opaque to us: the "per company" unit for
  -- the entitlement limit. Never resolvable to a hosted company.
  company_ref       text NOT NULL,
  provider          text,
  -- SHA-256 of the live handle (EB session_id / SKV access_token). Rotated on
  -- refresh. Unique per service so a handle maps to at most one ledger row.
  handle_hash       text,
  -- SHA-256 of the SKV refresh token, so a refresh exchange can be tied back
  -- to its connection without storing the token.
  refresh_hash      text,
  -- Bank account uids this connection covers (EB), for ownership checks on
  -- /accounts/{uid}/... calls.
  account_uids      text[] NOT NULL DEFAULT '{}',
  status            text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'revoked')),
  -- Signed connector-state nonce while a consent round-trip is in flight, so
  -- the callback can find the pending row.
  pending_state     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  activated_at      timestamptz,
  last_used_at      timestamptz,
  revoked_at        timestamptz
);

CREATE INDEX idx_connector_connections_key ON public.connector_connections (connector_key_id, service, status);
CREATE INDEX idx_connector_connections_company ON public.connector_connections (connector_key_id, company_ref, service) WHERE status = 'active';
CREATE UNIQUE INDEX idx_connector_connections_handle ON public.connector_connections (service, handle_hash) WHERE handle_hash IS NOT NULL;
CREATE INDEX idx_connector_connections_pending_state ON public.connector_connections (pending_state) WHERE pending_state IS NOT NULL;

ALTER TABLE public.connector_connections ENABLE ROW LEVEL SECURITY;
-- No policies: service role only.

-- 3. Global upstream budget. One shared counter per (service, window), so all
--    connector traffic is bounded well below the ASPSP-provider quota that is
--    shared with hosted. Same shape and RPC pattern as agent_rate_counters.
CREATE TABLE public.connector_upstream_counters (
  service      text NOT NULL,
  window_kind  text NOT NULL CHECK (window_kind IN ('minute', 'hour')),
  window_key   text NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (service, window_kind, window_key)
);

ALTER TABLE public.connector_upstream_counters ENABLE ROW LEVEL SECURITY;
CREATE POLICY connector_upstream_counters_no_select ON public.connector_upstream_counters FOR SELECT USING (false);

-- Reserve one upstream call against the global budget. Returns { ok, scope,
-- retry_after_sec }. Atomic increment-then-check with rollback, so two
-- concurrent proxy requests cannot both slip past the ceiling.
CREATE OR REPLACE FUNCTION public.connector_reserve_upstream(
  p_service    text,
  p_minute_max integer,
  p_hour_max   integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_minute_key text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI');
  v_hour_key   text := to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24');
  v_minute_count integer;
  v_hour_count   integer;
BEGIN
  INSERT INTO public.connector_upstream_counters (service, window_kind, window_key, count)
  VALUES (p_service, 'minute', v_minute_key, 1)
  ON CONFLICT (service, window_kind, window_key)
  DO UPDATE SET count = connector_upstream_counters.count + 1, updated_at = now()
  RETURNING count INTO v_minute_count;

  IF v_minute_count > p_minute_max THEN
    UPDATE public.connector_upstream_counters SET count = count - 1
      WHERE service = p_service AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'minute', 'retry_after_sec', 60);
  END IF;

  INSERT INTO public.connector_upstream_counters (service, window_kind, window_key, count)
  VALUES (p_service, 'hour', v_hour_key, 1)
  ON CONFLICT (service, window_kind, window_key)
  DO UPDATE SET count = connector_upstream_counters.count + 1, updated_at = now()
  RETURNING count INTO v_hour_count;

  IF v_hour_count > p_hour_max THEN
    UPDATE public.connector_upstream_counters SET count = count - 1
      WHERE service = p_service AND window_kind = 'hour' AND window_key = v_hour_key;
    UPDATE public.connector_upstream_counters SET count = count - 1
      WHERE service = p_service AND window_kind = 'minute' AND window_key = v_minute_key;
    RETURN jsonb_build_object('ok', false, 'scope', 'hour', 'retry_after_sec', 3600);
  END IF;

  RETURN jsonb_build_object('ok', true);
END;
$$;

REVOKE ALL ON FUNCTION public.connector_reserve_upstream(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.connector_reserve_upstream(text, integer, integer) TO service_role;

-- 4. validate RPC v2: also return the key's limits, so the proxy has the
--    entitlement caps in the same round-trip as auth. Additive: the return
--    columns 1-7 are unchanged from 20260831190000, `limits` is appended.
DROP FUNCTION IF EXISTS public.validate_and_increment_connector_key(text);
CREATE FUNCTION public.validate_and_increment_connector_key(p_key_hash text)
RETURNS TABLE(
  connector_key_id   uuid,
  org_number         text,
  instance_url       text,
  scopes             text[],
  status             text,
  current_period_end timestamptz,
  rate_limited       boolean,
  limits             jsonb
)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_org_number text;
  v_instance_url text;
  v_scopes text[];
  v_status text;
  v_period_end timestamptz;
  v_limits jsonb;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
BEGIN
  SELECT ck.id, ck.org_number, ck.instance_url, ck.scopes, ck.status, ck.current_period_end, ck.limits,
         ck.rate_limit_rpm, ck.request_count, ck.rate_limit_window_start
    INTO v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, v_limits,
         v_rate_limit_rpm, v_request_count, v_window_start
    FROM public.connector_keys ck
   WHERE ck.key_hash = p_key_hash
     AND ck.revoked_at IS NULL
     AND ck.status <> 'revoked'
     FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN;
  END IF;

  IF v_status <> 'active' THEN
    UPDATE public.connector_keys SET last_seen_at = now() WHERE id = v_id;
    RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, false, v_limits;
    RETURN;
  END IF;

  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.connector_keys
       SET request_count = 1, rate_limit_window_start = now(), last_seen_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, false, v_limits;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, true, v_limits;
    RETURN;
  END IF;

  UPDATE public.connector_keys
     SET request_count = request_count + 1, last_seen_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, false, v_limits;
END;
$$;

REVOKE ALL ON FUNCTION public.validate_and_increment_connector_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_connector_key(text) TO service_role;

COMMENT ON TABLE public.connector_connections IS
  'Secret-free ledger of bank/SKV connections a self-hosted instance obtained through its connector key. handle_hash = sha256 of the upstream handle; the handle never rests here. Service-role only.';
