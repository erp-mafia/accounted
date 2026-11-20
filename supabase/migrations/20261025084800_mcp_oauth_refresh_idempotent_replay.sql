-- MCP OAuth: a retried refresh no longer revokes the connection (crm#1043).
-- pg-test: tests/pg/mcp-oauth-refresh-idempotent-replay.pg.test.ts
--
-- Problem. rotate_mcp_refresh_token (20260621130000) used the clock to decide
-- whether a presented, already-rotated refresh token was a legitimate retry.
-- Inside a 120 s grace window it minted ANOTHER new pair over the one the
-- first rotation had just handed out; after the window it revoked the whole
-- grant. Both strand a legitimate client:
--   * a retry after the window (a response lost on the way, a client that
--     did not persist the rotated token) revoked the connection;
--   * two concurrent refreshes inside the window each got a different pair,
--     and the second overwrote the first: a client that kept the first
--     answer was refused ('invalid') on its next refresh.
-- Either way the client holds a dead credential, and a connected Claude
-- loses its tools until the user disconnects and reconnects.
--
-- Fix. The grant's state decides, not the clock:
--   * The immediate predecessor of the current refresh token is answered
--     idempotently with the SAME successor, however late it arrives. Its
--     successor cannot have been used: using it would have rotated the grant
--     and moved this token out of the predecessor slot. The token endpoint
--     derives the successor from the presented token
--     (deriveRotatedCredentials in src/lib/auth/api-keys.ts), so the same
--     token always rotates into the same pair and nothing reversible is
--     stored. When the current pair is not the presented token's derived
--     successor (rotated before this migration, or by an instance still on
--     the previous code), it is replaced once by the derived pair.
--   * A token two or more generations old, i.e. presented after its
--     successor was used, is reuse (RFC 9700 4.14.2): the grant is revoked.
--     The old design remembered one previous token only, so a token two
--     generations old read as unknown and revoked nothing. Every token that
--     leaves the predecessor slot is now kept in
--     api_key_retired_refresh_tokens for 30 days, so reuse is recognised at
--     any depth inside that window.
-- The access-key grace is unchanged: on rotation the superseded access key
-- stays valid for p_grace_seconds, so requests already in flight finish.
-- previous_refresh_expires_at is no longer read and is written NULL on
-- rotation; the column stays because api_keys_guard_jwt_writes names it.
--
-- The function gains api_key_id in its result so the token endpoint can log
-- a revoke-on-reuse with the key id (never the token). A changed result type
-- needs DROP + CREATE, which resets EXECUTE to the default, so the
-- service_role-only grant from 20260902090000 is restated below.

CREATE TABLE public.api_key_retired_refresh_tokens (
  token_hash  text PRIMARY KEY,
  api_key_id  uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  retired_at  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.api_key_retired_refresh_tokens IS
  'SHA-256 of MCP OAuth refresh tokens two or more generations old, per grant (api_keys row). Presenting one revokes the grant (reuse detection, RFC 9700 4.14.2). Written and pruned (30 days) by rotate_mcp_refresh_token only.';

CREATE INDEX idx_api_key_retired_refresh_tokens_key
  ON public.api_key_retired_refresh_tokens (api_key_id, retired_at);

ALTER TABLE public.api_key_retired_refresh_tokens ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, DELETE ON TABLE public.api_key_retired_refresh_tokens TO service_role;
-- no-grant: authenticated on public.api_key_retired_refresh_tokens (service-role only: a token hash is a bearer lookup key, read and written by the SECURITY DEFINER rotation RPC alone)

DROP FUNCTION IF EXISTS public.rotate_mcp_refresh_token(text, text, text, text, integer);

-- Outcomes:
--   'rotated'       presented = current refresh token: the caller's pair
--                   becomes current, the presented token the predecessor, the
--                   old predecessor is retired, the superseded access key
--                   gets p_grace_seconds.
--   'replayed'      presented = the predecessor: the current pair is its
--                   successor and is returned again (no write when it is the
--                   caller's derived pair).
--   'reuse_revoked' presented = a retired token: the grant is revoked.
--   'revoked'       the matched grant was already revoked.
--   'invalid'       no grant knows the token.
CREATE FUNCTION public.rotate_mcp_refresh_token(
  p_presented_hash    text,
  p_new_refresh_hash  text,
  p_new_key_hash      text,
  p_new_key_prefix    text,
  p_grace_seconds     integer
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
BEGIN
  -- 1. The current refresh token: normal rotation.
  SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash, ak.previous_refresh_token_hash
    INTO v_id, v_revoked, v_scopes, v_cur_key_hash, v_prev_refresh_hash
  FROM public.api_keys ak
  WHERE ak.refresh_token_hash = p_presented_hash
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
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
  SELECT ak.id, ak.revoked_at, ak.scopes, ak.key_hash, ak.refresh_token_hash
    INTO v_id, v_revoked, v_scopes, v_cur_key_hash, v_cur_refresh_hash
  FROM public.api_keys ak
  WHERE ak.previous_refresh_token_hash = p_presented_hash
  FOR UPDATE;

  IF v_id IS NOT NULL THEN
    IF v_revoked IS NOT NULL THEN
      RETURN QUERY SELECT 'revoked'::text, NULL::text[], v_id;
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
    SELECT ak.revoked_at INTO v_revoked
    FROM public.api_keys ak
    WHERE ak.id = v_id
    FOR UPDATE;

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

REVOKE EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rotate_mcp_refresh_token(text, text, text, text, integer)
  TO service_role;

NOTIFY pgrst, 'reload schema';
