-- An OAuth connection follows its user when the company it was bound to is
-- archived or left, instead of dying while its refresh grant keeps working.
-- pg-test: tests/pg/api-key-stale-company.pg.test.ts
--
-- Finding (crm#1043): an api_keys row stores the company it was bound to, and
-- nothing updates that value when the company is archived (a migration reset
-- archives the source company and hands the user a replacement, which becomes
-- their active company) or when the user leaves it. The membership block
-- added by 20260902090000 then refused the key on every request (401
-- upstream), although a key without allowlist rows reaches every live
-- company its user belongs to (api_key_companies, 20260928112724). The OAuth
-- refresh grant (rotate_mcp_refresh_token) does not run that check, so MCP
-- clients kept refreshing successfully, got 401 on every call, and showed the
-- connection as connected with no tools until the user reconnected. On
-- 2026-10-06, 43 live OAuth keys were bound to a company that was gone, 41 of
-- them for users who still had a live company.
--
-- The function below is copied VERBATIM from 20260928112724 (the latest
-- definition) with two changes. Signature and return type are unchanged, so
-- CREATE OR REPLACE keeps owner and privileges; the REVOKE/GRANT is restated
-- so the file stands alone.
--
-- 1. An OAuth connection (refresh_token_hash IS NOT NULL: only the OAuth
--    token endpoint sets it, and api_keys_guard_jwt_writes refuses it from a
--    user session) without allowlist rows, whose stored company is no longer
--    a live membership, is unbound instead of refused: company_id is cleared
--    on the row and comes back NULL. validateApiKey's lazy bind
--    (lib/auth/api-keys.ts, issue #1814) then binds it to the user's active
--    company on the same request, seat gate included, which is the company a
--    reconnect would bind a new key to; while the user has no company it
--    answers NO_COMPANY_YET like a key minted before onboarding. The key
--    never answers with the company that is gone, so an offboarded user still
--    loses that company; what changes is that their other companies stay
--    reachable, as the allowlist semantics already promise. The unbinding is
--    a configuration change, so the api_keys audit trigger records it.
--    Manual keys keep failing closed: an unattended script must not start
--    writing into another company without its owner noticing.
--
-- 2. A restricted key whose stored company is on its allowlist but no longer
--    a live membership takes its first live allowed company, the rule that
--    already applied to a stored company outside the allowlist or absent.
--    Nothing live left still refuses. A restricted key is never unbound by
--    change 1: the lazy bind resolves the active company without looking at
--    the allowlist.

CREATE OR REPLACE FUNCTION public.validate_and_increment_api_key(p_key_hash text)
RETURNS TABLE(
  user_id uuid,
  company_id uuid,
  api_key_id uuid,
  api_key_name text,
  rate_limited boolean,
  scopes text[],
  mode text,
  unattended_commit_limit numeric,
  allowed_company_ids uuid[],
  read_only_company_ids uuid[]
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
  v_read_only_company_ids uuid[];
  v_is_oauth boolean;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit, ak.refresh_token_hash IS NOT NULL
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit, v_is_oauth
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
  -- membership is reachable), else the listed ids in creation order. The
  -- read-only subset rides the same scan: NULL when no row is read-only.
  SELECT array_agg(akc.company_id ORDER BY akc.created_at, akc.company_id),
         array_agg(akc.company_id ORDER BY akc.created_at, akc.company_id)
           FILTER (WHERE akc.access = 'read')
  INTO v_allowed_company_ids, v_read_only_company_ids
  FROM public.api_key_companies akc
  WHERE akc.api_key_id = v_id;

  -- A restricted key's default must be reachable: when the stored default is
  -- outside the allowlist, absent, or no longer a live membership (archived,
  -- or a company the user left), the first allowed company the user is
  -- still a live member of takes its place. Nothing left means the key
  -- reaches nothing: treated as an unknown key, like the membership block.
  IF v_allowed_company_ids IS NOT NULL
     AND (
       v_company_id IS NULL
       OR v_company_id <> ALL (v_allowed_company_ids)
       OR NOT EXISTS (
         SELECT 1
         FROM public.company_members cm
         JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
         WHERE cm.user_id = v_user_id
           AND cm.company_id = v_company_id
       )
     ) THEN
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
  -- An OAuth connection without allowlist rows is unbound instead of refused:
  -- validateApiKey's lazy bind attaches it to the user's active company, the
  -- one a reconnect would bind a new key to. It never answers with the
  -- company that is gone. A manual key still fails closed.
  IF v_company_id IS NOT NULL AND NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = v_user_id
      AND cm.company_id = v_company_id
  ) THEN
    IF NOT v_is_oauth OR v_allowed_company_ids IS NOT NULL THEN
      RETURN;  -- treated as an unknown key: 401 upstream
    END IF;

    UPDATE public.api_keys
       SET company_id = NULL
     WHERE id = v_id;
    v_company_id := NULL;
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;
