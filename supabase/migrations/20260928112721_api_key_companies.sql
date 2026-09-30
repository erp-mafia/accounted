-- Per-key company allowlist ("one connection, every company" follow-up).
-- pg-test: tests/pg/api-key-companies.pg.test.ts
--
-- An API key is issued to a user and reaches every non-archived company that
-- user is a member of (validate_and_increment_api_key + the membership checks
-- in lib/api/v1/with-api-v1.ts and the MCP company routing). A consultant
-- who hands a key to one client's agent, or a company owner who connects a
-- tool that must only ever see one of their companies, has had no way to
-- narrow that. api_key_companies is that narrowing: an optional per-key
-- allowlist that the validation RPC returns alongside the key, so every
-- door (MCP, v1 REST) can intersect it with live membership at call time.
--
-- Semantics (also on the table comment):
--   no rows       the key reaches every company its user belongs to, today's
--                 behaviour, and follows future memberships;
--   one or more   the key reaches only those companies. Always intersected
--                 with live membership at every call: the allowlist can only
--                 narrow access, never widen it. A company the user has left
--                 stays unreachable whether or not it is listed here.
--
-- Access: service role only, no policies, like provider_consent_tokens /
-- provider_otc in 20260902090000 (section 5) and the connector key tables in
-- 20260831190000. Every reader is the SECURITY DEFINER validation RPC below
-- or a route that already runs the service client for api_keys; a member
-- policy would only re-open the "read a colleague's key configuration" class
-- of problem that 20260902090000 closed. The settings routes that manage the
-- allowlist must therefore write through the service client, never through
-- the cookie-session client.

CREATE TABLE public.api_key_companies (
  api_key_id uuid NOT NULL REFERENCES public.api_keys(id) ON DELETE CASCADE,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (api_key_id, company_id)
);

CREATE INDEX idx_api_key_companies_company_id
  ON public.api_key_companies (company_id);

COMMENT ON TABLE public.api_key_companies IS
  'Optional per-key company allowlist. No rows for a key: the key reaches every non-archived company its user is a member of (follows future memberships). One or more rows: the key reaches only those companies, intersected with live membership at every call. The allowlist never widens access. Service role only; read by validate_and_increment_api_key.';

ALTER TABLE public.api_key_companies ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.api_key_companies FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.api_key_companies TO service_role;

-- validate_and_increment_api_key: surface the allowlist and keep the default
-- reachable.
--
-- The body below is copied VERBATIM from 20260902090000 (the latest
-- definition, which added the membership check and the fixed search_path)
-- with exactly two changes:
--   1. allowed_company_ids uuid[] joins the RETURNS TABLE: NULL when the key
--      has no api_key_companies rows, else the listed ids ordered by
--      created_at. Returned in all three RETURN QUERY branches.
--   2. When the allowlist is non-empty and the key's stored default company
--      is not in it (or the key has no default yet), the default becomes the
--      first allowed company, ordered by created_at, that the user is still a
--      live member of. A key whose allowlist names no company the user still
--      belongs to reaches nothing and is treated as unknown (401 upstream),
--      the same fail-closed answer the membership block gives.
-- The membership block then runs on the effective default exactly as
-- before, so a key whose user left its (allowed) default company is still
-- refused. The stored api_keys.company_id is never rewritten here: the swap
-- is computed on every validation so it follows allowlist edits.
--
-- The return type changes, so the function is dropped and re-created (CREATE
-- OR REPLACE cannot change a RETURNS TABLE), as 20260831111519 did.
DROP FUNCTION IF EXISTS public.validate_and_increment_api_key(text);

CREATE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[],
  mode text,
  unattended_commit_limit numeric,
  allowed_company_ids uuid[]
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
  v_allowed_company_ids uuid[];
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

  -- Per-key company allowlist: NULL when the key has no rows (every
  -- membership is reachable), else the listed ids in creation order.
  SELECT array_agg(akc.company_id ORDER BY akc.created_at, akc.company_id)
  INTO v_allowed_company_ids
  FROM public.api_key_companies akc
  WHERE akc.api_key_id = v_id;

  -- A restricted key's default must be reachable: when the stored default is
  -- outside the allowlist (or absent), the first allowed company the user is
  -- still a live member of takes its place. Nothing left means the key
  -- reaches nothing: treated as an unknown key, like the membership block.
  IF v_allowed_company_ids IS NOT NULL
     AND (v_company_id IS NULL OR v_company_id <> ALL (v_allowed_company_ids)) THEN
    SELECT akc.company_id
    INTO v_company_id
    FROM public.api_key_companies akc
    JOIN public.company_members cm
      ON cm.company_id = akc.company_id AND cm.user_id = v_user_id
    JOIN public.companies c
      ON c.id = akc.company_id AND c.archived_at IS NULL
    WHERE akc.api_key_id = v_id
    ORDER BY akc.created_at, akc.company_id
    LIMIT 1;

    IF v_company_id IS NULL THEN
      RETURN;  -- allowlist names no company the user still belongs to: 401 upstream
    END IF;
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
                        v_unattended_commit_limit, v_allowed_company_ids;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_allowed_company_ids;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
