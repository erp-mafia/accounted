-- Security audit 2026-09-01, critical items (report "Accounted Security Audit").
-- pg-test: tests/pg/security-api-keys-provider-tokens.pg.test.ts
--
-- 1. api_keys identity binding. 20260422120000 replaced the original
--    `auth.uid() = user_id` INSERT check with `user_is_company_admin(company_id)`
--    and dropped the self-binding. Every API-key consumer trusts
--    api_keys.user_id as the acting identity (validate_and_increment_api_key,
--    lib/auth/api-keys.ts, lib/api/v1/with-api-v1.ts, the MCP company
--    routing), so an admin of ANY company could insert a key with a
--    co-member's user_id and act as that user in every company they belong
--    to. INSERT now requires user_id = auth.uid() again, on top of the admin
--    gate; a BEFORE trigger repeats that for JWT sessions and freezes the
--    identity and credential columns against UPDATE from user sessions. The
--    service role (settings routes, OAuth token endpoint, rotation) is
--    unaffected: the trigger is a no-op when the JWT role is not
--    anon/authenticated.
--
-- 2. api_keys SELECT was company-scoped, so every member (including
--    viewers) could read every other member's key_hash and
--    refresh_token_hash. Now: own keys, or company admins.
--
-- 3. rotate_mcp_refresh_token and validate_and_increment_api_key match rows
--    purely by a presented SHA-256 and were executable by `authenticated`.
--    Combined with (2) that made the stored hash a bearer credential: read a
--    colleague's refresh_token_hash, call rotate with your own new key hash,
--    own their connector. Both functions are only ever called through the
--    cookieless service client, so EXECUTE is now service_role only.
--
-- 4. validate_and_increment_api_key fails closed when the key's user is no
--    longer a member of the key's company (offboarded users kept reading a
--    company through MCP resources/read on the key's company_id snapshot).
--    Company-less keys (the OAuth lazy-bind path, 20260826090000) are left
--    alone: they carry no company to check.
--
-- 5. provider_consent_tokens / provider_otc. The DELETE policies from
--    20260402010000 subselect `company_id FROM team_members`; team_members has
--    no such column, so Postgres binds the name to the outer
--    provider_consents.company_id and the predicate collapses to "the caller
--    has at least one team_members row", which every user has
--    (ensure_user_team). Live check 2026-09-01: an unrelated team member
--    matched 123 of 126 token rows. The 20260415000000 schema sync only
--    recreated the policy IF NOT EXISTS, so the broken one survived. Every
--    code path to these two tables uses the service client
--    (lib/providers/resolve-consent.ts, extensions/general/arcim-migration),
--    so all member policies are dropped and table privileges revoked from
--    anon/authenticated: service role only.

-- 1 + 2: api_keys policies -----------------------------------------------

DROP POLICY IF EXISTS "api_keys_insert" ON public.api_keys;
CREATE POLICY "api_keys_insert" ON public.api_keys
  FOR INSERT
  WITH CHECK (user_id = auth.uid() AND public.user_is_company_admin(company_id));

DROP POLICY IF EXISTS "api_keys_select" ON public.api_keys;
CREATE POLICY "api_keys_select" ON public.api_keys
  FOR SELECT
  USING (user_id = auth.uid() OR public.user_is_company_admin(company_id));

CREATE OR REPLACE FUNCTION public.api_keys_guard_jwt_writes()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(
    nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role',
    ''
  );
BEGIN
  -- service_role, pg_cron, migrations and the pg-real harness carry no
  -- end-user role claim: nothing to enforce.
  IF v_jwt_role NOT IN ('anon', 'authenticated') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.user_id IS DISTINCT FROM auth.uid() THEN
      RAISE EXCEPTION 'api_keys: user_id must be the calling user'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.refresh_token_hash IS NOT NULL
       OR NEW.previous_key_hash IS NOT NULL
       OR NEW.previous_refresh_token_hash IS NOT NULL THEN
      RAISE EXCEPTION 'api_keys: refresh-token material is set only by the OAuth token endpoint'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.key_hash IS DISTINCT FROM OLD.key_hash
     OR NEW.key_prefix IS DISTINCT FROM OLD.key_prefix
     OR NEW.mode IS DISTINCT FROM OLD.mode
     OR NEW.refresh_token_hash IS DISTINCT FROM OLD.refresh_token_hash
     OR NEW.previous_key_hash IS DISTINCT FROM OLD.previous_key_hash
     OR NEW.previous_key_expires_at IS DISTINCT FROM OLD.previous_key_expires_at
     OR NEW.previous_refresh_token_hash IS DISTINCT FROM OLD.previous_refresh_token_hash
     OR NEW.previous_refresh_expires_at IS DISTINCT FROM OLD.previous_refresh_expires_at THEN
    RAISE EXCEPTION 'api_keys: identity and credential columns are immutable from a user session'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS api_keys_guard_jwt_writes ON public.api_keys;
CREATE TRIGGER api_keys_guard_jwt_writes
  BEFORE INSERT OR UPDATE ON public.api_keys
  FOR EACH ROW EXECUTE FUNCTION public.api_keys_guard_jwt_writes();

-- 3: hash-as-bearer RPCs become service_role only --------------------------

REVOKE EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  TO service_role;
ALTER FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  SET search_path = public;

-- 4: validate_and_increment_api_key with a membership check -----------------
-- Body identical to 20260831111519 apart from the membership block and the
-- fixed search_path.

CREATE OR REPLACE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[],
  mode text,
  unattended_commit_limit numeric
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_user_id uuid;
  v_company_id uuid;
  v_api_key_name text;
  v_rate_limit_rpm integer;
  v_request_count integer;
  v_window_start timestamptz;
  v_scopes text[];
  v_mode text;
  v_unattended_commit_limit numeric;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit
  FROM public.api_keys ak
  WHERE ak.revoked_at IS NULL
    AND (
      ak.key_hash = p_key_hash
      OR (
        ak.previous_key_hash = p_key_hash
        AND ak.previous_key_expires_at IS NOT NULL
        AND ak.previous_key_expires_at > now()
      )
    )
  FOR UPDATE;

  IF v_id IS NULL THEN
    RETURN;  -- no live match (incl. expired grace): caller returns 401, as before
  END IF;

  -- A key outlives neither the membership it was minted under nor the company
  -- itself. Company-less keys (OAuth lazy bind) have nothing to check yet.
  IF v_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = v_user_id
      AND cm.company_id = v_company_id
  ) THEN
    RETURN;  -- treated as an unknown key: 401 upstream
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                        v_unattended_commit_limit;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

-- 5: provider token tables become service_role only --------------------------

DROP POLICY IF EXISTS provider_consent_tokens_select ON public.provider_consent_tokens;
DROP POLICY IF EXISTS provider_consent_tokens_insert ON public.provider_consent_tokens;
DROP POLICY IF EXISTS provider_consent_tokens_update ON public.provider_consent_tokens;
DROP POLICY IF EXISTS provider_consent_tokens_delete ON public.provider_consent_tokens;
DROP POLICY IF EXISTS provider_otc_select ON public.provider_otc;
DROP POLICY IF EXISTS provider_otc_insert ON public.provider_otc;
DROP POLICY IF EXISTS provider_otc_update ON public.provider_otc;
DROP POLICY IF EXISTS provider_otc_delete ON public.provider_otc;

ALTER TABLE public.provider_consent_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.provider_otc ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.provider_consent_tokens FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.provider_otc FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.provider_consent_tokens TO service_role;
GRANT ALL ON TABLE public.provider_otc TO service_role;
