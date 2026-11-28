-- Client secrets for partner OAuth clients: a partner can be a confidential
-- client (RFC 6749 section 2.1) and authenticate at the token endpoint.
-- pg-test: tests/pg/oauth-partner-client-secrets.pg.test.ts
--
-- WHY
-- ---
-- The MCP OAuth endpoints treated every client as public: PKCE alone bound
-- the code, and the token endpoint read no client credentials, although the
-- discovery document listed client_secret_post. An integrator that serves
-- all of its customers through one callback is a row in
-- oauth_partner_clients (migration 20261122153300). Its server can keep a
-- secret, and the flow such an integration is built for is a client_id and a
-- client secret beside PKCE.
--
-- WHAT
-- ----
-- 1. public.oauth_partner_client_secrets: the SHA-256 of each secret issued
--    to a partner client. Rows sharing a slug are one client
--    (20261122153300), so the slug is the client's client_id and its secrets
--    are kept by slug: one client_id and one secret for all of the partner's
--    customers, whichever of its callbacks they sign in through.
-- 2. issue_oauth_partner_client_secret(slug, overlap): issues a new secret
--    and returns it once; only its hash is stored. Every secret the client
--    already holds stays valid for the overlap and then expires, so a
--    rotation never cuts the partner off. For the operator only: no API role
--    may call it.
-- 3. oauth_client_has_secret(client) and oauth_client_authentication(client,
--    client_id, secret_hash): whether a grant's client holds a secret, and
--    whether a request authenticates as that client ('public' when it holds
--    none, 'authenticated' for its own client_id and a live secret,
--    'refused' otherwise). `client` is the api_keys.client form,
--    partner:<slug>. The token route asks before it exchanges a code (RFC
--    6749 section 4.1.3), the authorize route before it shows consent for a
--    client_id that is not the partner's.
-- 4. rotate_mcp_refresh_token_for_client: the refresh rotation of
--    rotate_mcp_refresh_token with the request's client credentials. A grant
--    whose client holds a secret answers 'client_auth_required' and writes
--    nothing unless the request authenticated as that client (RFC 6749
--    section 6), checked in the same transaction as the rotation.
--    rotate_mcp_refresh_token keeps its arguments, result and grants and
--    calls it without credentials, so a request without credentials, which
--    is every public client's, rotates exactly as before.
--
-- NO DOWNGRADE
-- ------------
-- A client that has been issued a secret is confidential for good: it holds
-- a secret while any row exists for its slug, revoked or expired. With every
-- secret revoked or expired it cannot authenticate at all until a new one is
-- issued; it is never treated as public again. Rows are therefore revoked,
-- never deleted (a trigger refuses DELETE), and slug, hash and creation time
-- never change.
--
-- OPERATING
-- ---------
-- Issue the first secret, or rotate, connected as postgres (the role that
-- adds partner rows):
--   SELECT * FROM public.issue_oauth_partner_client_secret('<slug>');
--   SELECT * FROM public.issue_oauth_partner_client_secret('<slug>', interval '0');
-- The first keeps the secrets the client already holds valid for 7 more days,
-- the second stops them now. The result names its fields as RFC 7591 section
-- 3.2.1 does (client_id, client_secret, client_id_issued_at,
-- client_secret_expires_at); the secret is shown this once and cannot be
-- read back. To stop one secret at once:
--   UPDATE public.oauth_partner_client_secrets SET revoked_at = now() WHERE id = '<id>';
-- The partner then authenticates at the token endpoint with HTTP Basic
-- (client_secret_basic) or with client_id and client_secret in the form body
-- (client_secret_post), on every code exchange and every refresh. PKCE stays
-- required.
--
-- ROLLING DEPLOY
-- --------------
--   * new database, old code: rotate_mcp_refresh_token rotates every grant
--     without a secret as before; a grant with one answers
--     'client_auth_required', which the old route reads as invalid_grant. No
--     secret exists before this migration, so nothing else differs.
--   * new code, old database: the route calls the new functions only for a
--     code bound to a partner client or a request that carries client
--     credentials. Those calls fail closed until the migration lands; every
--     other request makes the calls it made before.

-- Hot table (api_keys, read by the rotation): never queue every request
-- behind a long transaction. Fail the migration job instead and retry.
SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. public.oauth_partner_client_secrets
-- =============================================================================

CREATE TABLE public.oauth_partner_client_secrets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug         text NOT NULL,
  secret_hash  text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz,
  revoked_at   timestamptz,
  CONSTRAINT oauth_partner_client_secrets_slug_format
    CHECK (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT oauth_partner_client_secrets_hash_format
    CHECK (secret_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT oauth_partner_client_secrets_expires_after_created
    CHECK (expires_at IS NULL OR expires_at >= created_at),
  CONSTRAINT oauth_partner_client_secrets_revoked_after_created
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

COMMENT ON TABLE public.oauth_partner_client_secrets IS
  'Client secrets of partner OAuth clients (oauth_partner_clients), by slug: the slug is the client_id. Only the SHA-256 of a secret is stored. A slug with any row is a confidential client for good. Written by issue_oauth_partner_client_secret; revoked, never deleted. No API role reads it.';
COMMENT ON COLUMN public.oauth_partner_client_secrets.secret_hash IS
  'SHA-256 (hex) of the secret, as the token route hashes the presented client_secret. The secret itself is returned once by issue_oauth_partner_client_secret and stored nowhere.';
COMMENT ON COLUMN public.oauth_partner_client_secrets.expires_at IS
  'End of the overlap a later rotation left this secret; NULL while it is the newest. The secret authenticates until then.';
COMMENT ON COLUMN public.oauth_partner_client_secrets.revoked_at IS
  'Set to stop this secret at once. Final.';

CREATE UNIQUE INDEX uq_oauth_partner_client_secrets_hash
  ON public.oauth_partner_client_secrets (secret_hash);

CREATE INDEX idx_oauth_partner_client_secrets_slug
  ON public.oauth_partner_client_secrets (slug, created_at);

ALTER TABLE public.oauth_partner_client_secrets ENABLE ROW LEVEL SECURITY;
-- No policies and no API role at all: the hashes are read only through the
-- SECURITY DEFINER functions below, and only the operator writes.
REVOKE ALL ON TABLE public.oauth_partner_client_secrets FROM PUBLIC, anon, authenticated, service_role;

-- Who a secret belongs to, its hash and when it was issued never change, a
-- revocation is final, and no row is deleted: a deleted row would turn a
-- confidential client public again.
CREATE FUNCTION public.oauth_partner_client_secrets_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'oauth_partner_client_secrets: a secret is revoked, never deleted'
      USING ERRCODE = '42501';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.slug IS DISTINCT FROM OLD.slug
     OR NEW.secret_hash IS DISTINCT FROM OLD.secret_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'oauth_partner_client_secrets: slug, hash and creation time are fixed'
      USING ERRCODE = '42501';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at THEN
    RAISE EXCEPTION 'oauth_partner_client_secrets: a revoked secret stays revoked'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.oauth_partner_client_secrets_guard() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER oauth_partner_client_secrets_guard
  BEFORE UPDATE OR DELETE ON public.oauth_partner_client_secrets
  FOR EACH ROW EXECUTE FUNCTION public.oauth_partner_client_secrets_guard();

-- =============================================================================
-- 2. issue_oauth_partner_client_secret
-- =============================================================================
--
-- 32 random bytes, hex, behind a recognisable prefix: 256 bits, so the
-- secret cannot be guessed (RFC 6749 section 10.10), and every character is
-- unreserved, so form encoding leaves it as it is in both client_secret_basic
-- and client_secret_post. The overlap is capped at 30 days; 0 stops the
-- previous secrets now. Rotations of one client are serialised, so two at
-- once still leave one newest secret.

CREATE FUNCTION public.issue_oauth_partner_client_secret(
  p_slug    text,
  p_overlap interval DEFAULT interval '7 days'
)
RETURNS TABLE (
  client_id                  text,
  client_secret              text,
  client_id_issued_at        bigint,
  client_secret_expires_at   bigint,
  previous_secrets_expire_at timestamptz
)
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_issued_at timestamptz;
  v_until     timestamptz;
  v_previous  integer;
  v_secret    text;
BEGIN
  IF p_overlap IS NULL OR p_overlap < interval '0' OR p_overlap > interval '30 days' THEN
    RAISE EXCEPTION 'issue_oauth_partner_client_secret: the overlap must be between 0 and 30 days'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.oauth_partner_clients c
     WHERE c.slug = p_slug AND c.revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'issue_oauth_partner_client_secret: no active partner client has the slug %', p_slug
      USING ERRCODE = 'P0002';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('oauth_partner_client_secret:' || p_slug, 0));

  SELECT min(c.created_at) INTO v_issued_at
    FROM public.oauth_partner_clients c
   WHERE c.slug = p_slug;

  v_until := now() + p_overlap;
  UPDATE public.oauth_partner_client_secrets s
     SET expires_at = least(coalesce(s.expires_at, 'infinity'::timestamptz), v_until)
   WHERE s.slug = p_slug
     AND s.revoked_at IS NULL
     AND (s.expires_at IS NULL OR s.expires_at > now());
  GET DIAGNOSTICS v_previous = ROW_COUNT;

  v_secret := 'accounted_cs_' || encode(public.gen_random_bytes(32), 'hex');
  INSERT INTO public.oauth_partner_client_secrets (slug, secret_hash)
  VALUES (p_slug, encode(sha256(convert_to(v_secret, 'UTF8')), 'hex'));

  RETURN QUERY SELECT
    p_slug,
    v_secret,
    extract(epoch FROM v_issued_at)::bigint,
    0::bigint,
    CASE WHEN v_previous > 0 THEN v_until END;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.issue_oauth_partner_client_secret(text, interval)
  FROM PUBLIC, anon, authenticated, service_role;

-- =============================================================================
-- 3. oauth_client_has_secret / oauth_client_authentication
-- =============================================================================

CREATE FUNCTION public.oauth_client_has_secret(p_client text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(p_client ~ '^partner:[a-z][a-z0-9_]{1,39}$', false)
     AND EXISTS (
       SELECT 1 FROM public.oauth_partner_client_secrets s
        WHERE s.slug = substr(p_client, length('partner:') + 1)
     );
$$;

REVOKE EXECUTE ON FUNCTION public.oauth_client_has_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_client_has_secret(text) TO service_role;

-- p_client_secret_hash is the SHA-256 (hex) of the presented secret: the
-- secret never reaches the database, and a match is an index lookup on the
-- hash, not a comparison of the secret.
CREATE FUNCTION public.oauth_client_authentication(
  p_client             text,
  p_client_id          text,
  p_client_secret_hash text
)
RETURNS text
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE
    WHEN NOT public.oauth_client_has_secret(p_client) THEN 'public'
    WHEN p_client_id IS NOT DISTINCT FROM substr(p_client, length('partner:') + 1)
         AND EXISTS (
           SELECT 1 FROM public.oauth_partner_client_secrets s
            WHERE s.slug = p_client_id
              AND s.secret_hash = p_client_secret_hash
              AND s.revoked_at IS NULL
              AND (s.expires_at IS NULL OR s.expires_at > now())
         ) THEN 'authenticated'
    ELSE 'refused'
  END;
$$;

REVOKE EXECUTE ON FUNCTION public.oauth_client_authentication(text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oauth_client_authentication(text, text, text) TO service_role;

-- =============================================================================
-- 4. rotate_mcp_refresh_token_for_client / rotate_mcp_refresh_token
-- =============================================================================
--
-- The body is copied VERBATIM from rotate_mcp_refresh_token in
-- 20261029100000 (the latest definition) with these changes and nothing
-- else:
--   * the two client parameters;
--   * the grant's client is read with the row in steps 1, 2 and 3;
--   * right after each step finds the grant, before any other answer, a
--     grant whose client holds a secret answers the new outcome
--     'client_auth_required' and writes nothing unless the request
--     authenticated as that client. Step 3 does not revoke the grant then:
--     a retired token is no use without the secret, so presenting one
--     without it changes nothing.
--
-- Outcomes:
--   'rotated'       presented = current refresh token: the caller's pair
--                   becomes current, the presented token the predecessor, the
--                   old predecessor is retired, the superseded access key
--                   gets p_grace_seconds.
--   'replayed'      presented = the predecessor: the current pair is its
--                   successor and is returned again (no write when it is the
--                   caller's derived pair).
--   'client_auth_required'
--                   the grant's client holds a secret and the request did
--                   not authenticate as it: nothing is written.
--   'paused'        steps 1 and 2 matched a live grant whose agent identity
--                   is paused: nothing is written.
--   'reuse_revoked' presented = a retired token: the grant is revoked.
--   'revoked'       the matched grant was already revoked.
--   'invalid'       no grant knows the token.
CREATE FUNCTION public.rotate_mcp_refresh_token_for_client(
  p_presented_hash        text,
  p_new_refresh_hash      text,
  p_new_key_hash          text,
  p_new_key_prefix        text,
  p_grace_seconds         integer,
  p_client_id             text,
  p_client_secret_hash    text
)
RETURNS TABLE(outcome text, scopes text[], api_key_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_id uuid;
  v_revoked timestamptz;
  v_scopes text[];
  v_cur_key_hash text;
  v_cur_refresh_hash text;
  v_prev_refresh_hash text;
  v_agent_identity_id uuid;
  v_client text;
BEGIN
  -- 1. The current refresh token: normal rotation.
  SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash, ak.previous_refresh_token_hash, ak.agent_identity_id, ak.client
    INTO v_id, v_revoked, v_scopes, v_cur_key_hash, v_prev_refresh_hash, v_agent_identity_id, v_client
  FROM public.api_keys ak
  WHERE ak.refresh_token_hash = p_presented_hash
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    -- A client with a secret refreshes only as itself (RFC 6749 section 6).
    IF public.oauth_client_authentication(v_client, p_client_id, p_client_secret_hash) = 'refused' THEN
      RETURN QUERY SELECT 'client_auth_required'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- A paused agent gets no new credentials while it is paused.
    IF v_agent_identity_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.agent_identities ai
      WHERE ai.id = v_agent_identity_id AND ai.paused_at IS NOT NULL
    ) THEN
      RETURN QUERY SELECT 'paused'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- The old predecessor is now two generations behind: from here on,
    -- presenting it is reuse.
    IF v_prev_refresh_hash IS NOT NULL THEN
      INSERT INTO public.api_key_retired_refresh_tokens (token_hash, api_key_id)
      VALUES (v_prev_refresh_hash, v_id)
      ON CONFLICT (token_hash) DO NOTHING;
    END IF;
    DELETE FROM public.api_key_retired_refresh_tokens r
     WHERE r.api_key_id = v_id
       AND r.retired_at < now() - interval '30 days';

    UPDATE public.api_keys ak
       SET previous_refresh_token_hash = p_presented_hash,
           previous_refresh_expires_at = NULL,
           previous_key_hash           = v_cur_key_hash,
           previous_key_expires_at     = now() + make_interval(secs => p_grace_seconds),
           refresh_token_hash          = p_new_refresh_hash,
           key_hash                    = p_new_key_hash,
           key_prefix                  = p_new_key_prefix
     WHERE ak.id = v_id;
    RETURN QUERY SELECT 'rotated'::text, v_scopes, v_id;
    RETURN;
  END IF;

  -- 2. The predecessor: an idempotent retry, however late.
  SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash, ak.refresh_token_hash, ak.agent_identity_id, ak.client
    INTO v_id, v_revoked, v_scopes, v_cur_key_hash, v_cur_refresh_hash, v_agent_identity_id, v_client
  FROM public.api_keys ak
  WHERE ak.previous_refresh_token_hash = p_presented_hash
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    -- A client with a secret refreshes only as itself (RFC 6749 section 6).
    IF public.oauth_client_authentication(v_client, p_client_id, p_client_secret_hash) = 'refused' THEN
      RETURN QUERY SELECT 'client_auth_required'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- A paused agent gets no new credentials while it is paused.
    IF v_agent_identity_id IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.agent_identities ai
      WHERE ai.id = v_agent_identity_id AND ai.paused_at IS NOT NULL
    ) THEN
      RETURN QUERY SELECT 'paused'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- The current pair is the presented token's successor. When it is the
    -- caller's derived pair the answer is the same pair again and nothing is
    -- written. Otherwise (rotated before derivation existed) it was never
    -- used, or this token would not be the predecessor: replace it once with
    -- the derived pair, keeping the replaced access key on the grace window.
    IF v_cur_refresh_hash IS DISTINCT FROM p_new_refresh_hash
       OR v_cur_key_hash IS DISTINCT FROM p_new_key_hash THEN
      UPDATE public.api_keys ak
         SET previous_key_hash       = v_cur_key_hash,
             previous_key_expires_at = now() + make_interval(secs => p_grace_seconds),
             refresh_token_hash      = p_new_refresh_hash,
             key_hash                = p_new_key_hash,
             key_prefix              = p_new_key_prefix
       WHERE ak.id = v_id;
    END IF;
    RETURN QUERY SELECT 'replayed'::text, v_scopes, v_id;
    RETURN;
  END IF;

  -- 3. Two or more generations old: reuse after the successor was used.
  SELECT r.api_key_id INTO v_id
  FROM public.api_key_retired_refresh_tokens r
  WHERE r.token_hash = p_presented_hash;

  IF v_id IS NOT NULL THEN
    SELECT ak.revoked_at, ak.client INTO v_revoked, v_client
    FROM public.api_keys ak
    WHERE ak.id = v_id
    FOR UPDATE;

    -- Without the secret a retired token is no use, so presenting one
    -- without it revokes nothing.
    IF public.oauth_client_authentication(v_client, p_client_id, p_client_secret_hash) = 'refused' THEN
      RETURN QUERY SELECT 'client_auth_required'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
      RETURN;
    END IF;

    -- One row holds the current and the previous credentials, so this kills
    -- the whole grant family at once.
    UPDATE public.api_keys ak
       SET revoked_at = now()
     WHERE ak.id = v_id;
    RETURN QUERY SELECT 'reuse_revoked'::text, NULL::text[], v_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'invalid'::text, NULL::text[], NULL::uuid;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.rotate_mcp_refresh_token_for_client(text, text, text, text, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_mcp_refresh_token_for_client(text, text, text, text, integer, text, text)
  TO service_role;

-- Arguments and result type are unchanged, so CREATE OR REPLACE keeps the
-- service_role-only grant; it is restated anyway. Without credentials a
-- grant whose client holds no secret rotates exactly as before, and one
-- whose client holds a secret answers 'client_auth_required'.
CREATE OR REPLACE FUNCTION public.rotate_mcp_refresh_token(
  p_presented_hash    text,
  p_new_refresh_hash  text,
  p_new_key_hash      text,
  p_new_key_prefix    text,
  p_grace_seconds     integer
)
RETURNS TABLE(outcome text, scopes text[], api_key_id uuid)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT * FROM public.rotate_mcp_refresh_token_for_client(
    p_presented_hash, p_new_refresh_hash, p_new_key_hash, p_new_key_prefix, p_grace_seconds, NULL, NULL
  );
$$;

REVOKE EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
