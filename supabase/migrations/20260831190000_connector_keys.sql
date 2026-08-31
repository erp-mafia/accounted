-- Connector keys: the hosted side of the sovereign self-host subscription.
--
-- A self-hosted Accounted instance runs everything itself except the services
-- only Accounted can operate (bank sync via our PSD2/AISP credentials, the
-- Skatteverket API client, TIC org lookup, the migration gateway). A
-- connector key (`gnubok_ck_...`) is what an instance presents to the hosted
-- proxy endpoints under /api/connect/*; this table is the registry of those
-- keys, the proxy's rate-limit state, and the billing hook for the
-- per-active-company subscription. The instance never stores accounting data
-- here: bank/SKV tokens and the ledger stay in the instance's own database,
-- the proxy is stateless. Enforcement is key auth at the proxy, never a
-- call-home licence check inside the AGPL code.
--
-- Service-role only: RLS is enabled with NO policies, so neither anon nor
-- authenticated can read a row (the hosted UI has no connector-key surface;
-- keys are issued by scripts/issue-connector-key.ts and, later, the Stripe
-- webhook). The validate RPC is SECURITY DEFINER and executable by
-- service_role alone (see the REVOKE/GRANT at the end): this is the lesson
-- of the SECURITY DEFINER exposure audit, applied up front.

CREATE TABLE public.connector_keys (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SHA-256 of the key. The key itself is shown once at issue time and never
  -- stored: the hash IS the credential lookup (same reasoning as api_keys).
  key_hash                text NOT NULL UNIQUE,
  -- Display prefix: 'gnubok_ck_' + 8 chars, safe to show in lists/logs.
  key_prefix              text NOT NULL,
  -- The licensee. Ten digits, no hyphen.
  org_number              text NOT NULL,
  licensee_name           text,
  -- The self-hosted instance this key belongs to (pinned: callbacks and
  -- usage are only ever honoured for this origin). NULL until first sync
  -- pins it for a manually issued key.
  instance_url            text,
  -- Capability keys the subscription covers. Subset of
  -- CONNECTOR_CAPABILITIES in lib/entitlements/keys.ts.
  scopes                  text[] NOT NULL DEFAULT ARRAY['bank_sync', 'skatteverket', 'org_lookup', 'migration'],
  status                  text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
  -- Billing hooks (Stripe self-serve comes later; manual keys leave these NULL).
  stripe_customer_id      text,
  stripe_subscription_id  text,
  -- End of the paid period. The instance's grants expire at
  -- min(now + 72h, current_period_end + 3d): a lapsed period freezes the
  -- connector capabilities within days even if the sync keeps running.
  current_period_end      timestamptz,
  -- Proxy rate limit, per key (requests per minute), same window scheme as
  -- api_keys.
  rate_limit_rpm          integer NOT NULL DEFAULT 600,
  request_count           integer NOT NULL DEFAULT 0,
  rate_limit_window_start timestamptz,
  -- Quantity billing input: the instance reports its active company count on
  -- every sync.
  active_company_count    integer NOT NULL DEFAULT 0,
  last_seen_at            timestamptz,
  last_synced_at          timestamptz,
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  revoked_at              timestamptz
);

CREATE INDEX idx_connector_keys_org_number ON public.connector_keys (org_number);
CREATE INDEX idx_connector_keys_status ON public.connector_keys (status) WHERE revoked_at IS NULL;

ALTER TABLE public.connector_keys ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only.

CREATE TRIGGER set_updated_at_connector_keys
  BEFORE UPDATE ON public.connector_keys
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Usage metering per key: one row per proxied request. Kept separate from
-- metered_events on purpose: that table's company_id references HOSTED
-- companies, and a connector key belongs to an instance, not a company here.
CREATE TABLE public.connector_usage_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_key_id uuid NOT NULL REFERENCES public.connector_keys(id) ON DELETE CASCADE,
  -- Which hosted service answered: entitlements | bank | skatteverket | org | migration.
  service          text NOT NULL,
  endpoint         text,
  status_code      integer,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  metadata         jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX idx_connector_usage_events_key_time
  ON public.connector_usage_events (connector_key_id, occurred_at DESC);

ALTER TABLE public.connector_usage_events ENABLE ROW LEVEL SECURITY;
-- No policies on purpose: service role only.

-- Atomic validate + rate-limit, the connector twin of
-- validate_and_increment_api_key (20260621130000). Returns no row for an
-- unknown or revoked key (caller answers 401), the row with its status for a
-- suspended key (caller answers 403), and rate_limited = true when the
-- per-minute window is exhausted (caller answers 429).
CREATE OR REPLACE FUNCTION public.validate_and_increment_connector_key(p_key_hash text)
RETURNS TABLE(
  connector_key_id   uuid,
  org_number         text,
  instance_url       text,
  scopes             text[],
  status             text,
  current_period_end timestamptz,
  rate_limited       boolean
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
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
BEGIN
  SELECT ck.id, ck.org_number, ck.instance_url, ck.scopes, ck.status, ck.current_period_end,
         ck.rate_limit_rpm, ck.request_count, ck.rate_limit_window_start
    INTO v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end,
         v_rate_limit_rpm, v_request_count, v_window_start
    FROM public.connector_keys ck
   WHERE ck.key_hash = p_key_hash
     AND ck.revoked_at IS NULL
     AND ck.status <> 'revoked'
     FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN;  -- unknown or revoked: caller answers 401
  END IF;

  -- A suspended key is reported, not rate-counted: the caller answers 403.
  IF v_status <> 'active' THEN
    UPDATE public.connector_keys SET last_seen_at = now() WHERE id = v_id;
    RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, false;
    RETURN;
  END IF;

  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.connector_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_seen_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, false;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, true;
    RETURN;
  END IF;

  UPDATE public.connector_keys
     SET request_count = request_count + 1,
         last_seen_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_id, v_org_number, v_instance_url, v_scopes, v_status, v_period_end, false;
END;
$$;

-- Service role only. Supabase grants EXECUTE on new public functions to PUBLIC
-- and explicitly to anon/authenticated; anon is a member of PUBLIC, so both
-- must be revoked for the revoke to bite.
REVOKE ALL ON FUNCTION public.validate_and_increment_connector_key(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_connector_key(text) TO service_role;

COMMENT ON TABLE public.connector_keys IS
  'Hosted registry of gnubok_ck_ connector keys presented by self-hosted instances at /api/connect/*. Service-role only.';
COMMENT ON TABLE public.connector_usage_events IS
  'Per-request metering for connector keys (entitlements, bank, skatteverket, org, migration). Service-role only.';
