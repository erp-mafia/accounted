-- validate_and_increment_api_key returns the key's per-minute limit and, on
-- the limited branch, the whole seconds left in its window (issue #225).
--
-- The function enforces a fixed one-minute window per key
-- (api_keys.rate_limit_window_start) and the limited branch does not slide
-- it, so the wait is rate_limit_window_start + 1 minute - now(). It is
-- computed here, on the database clock that set the window, rounded up and
-- held to 1..60. The application answers it as Retry-After and as
-- retry_after_seconds in the MCP tool result; until now it could only say 60,
-- the upper bound.
--
-- ROLLING DEPLOY (the RETURNS TABLE changes, so the function is dropped and
-- re-created under the same name, as 20261029100000 did):
--   * new database, old code: the old code reads the columns it knows by
--     name and ignores rate_limit_per_minute and retry_after_seconds.
--   * new code, old database: both are absent (read as undefined); the
--     application falls back to RATE_LIMIT_RETRY_AFTER_SECONDS (60) and no
--     limit.
-- supabase db push runs the file as one transaction, so no caller sees the
-- function missing between the DROP and the CREATE. Grants are restated.

-- Hot table (api_keys): never queue every request behind a long transaction.
-- Fail the migration job instead and retry.
SELECT set_config('lock_timeout', '5s', true);

-- The body is copied VERBATIM from 20261029100000 (the latest definition)
-- with these changes and nothing else:
--   * rate_limit_per_minute and retry_after_seconds join the RETURNS TABLE;
--   * every RETURN QUERY returns v_rate_limit_rpm; the limited branch returns
--     the seconds left in the window, the other two NULL.
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
  allowed_company_ids uuid[],
  read_only_company_ids uuid[],
  service_account_id uuid,
  service_account_name text,
  agent_identity_id uuid,
  client text,
  rate_limit_per_minute integer,
  retry_after_seconds integer
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
  v_service_account_id uuid;
  v_service_account_name text;
  v_agent_identity_id uuid;
  v_client text;
BEGIN
  -- Match the live key_hash, OR a previous (just-rotated) key_hash that is still
  -- inside its grace window. Both gated by revoked_at IS NULL.
  SELECT ak.id, ak.user_id, ak.company_id, ak.name,
         ak.rate_limit_rpm, ak.request_count, ak.rate_limit_window_start, ak.scopes, ak.mode,
         ak.unattended_commit_limit, ak.refresh_token_hash IS NOT NULL, ak.service_account_id,
         ak.agent_identity_id, ak.client
  INTO   v_id, v_user_id, v_company_id, v_api_key_name,
         v_rate_limit_rpm, v_request_count, v_window_start, v_scopes, v_mode,
         v_unattended_commit_limit, v_is_oauth, v_service_account_id,
         v_agent_identity_id, v_client
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

  -- A paused agent acts nowhere, whatever else the key may do: no row, and
  -- nothing counted. 403 AGENT_PAUSED upstream (see api_key_refusal).
  IF v_agent_identity_id IS NOT NULL AND EXISTS (
    SELECT 1
    FROM public.agent_identities ai
    WHERE ai.id = v_agent_identity_id
      AND ai.paused_at IS NOT NULL
  ) THEN
    RETURN;
  END IF;

  IF v_service_account_id IS NOT NULL THEN
    -- A service account acts only while it is active (not revoked, company
    -- live, sponsor an owner or admin there) and only in its own company.
    -- Its sponsor is the key's user (api_keys_guard_service_account keeps it
    -- so); checked again here so a broken row fails closed.
    SELECT sa.company_id, sa.name
    INTO v_company_id, v_service_account_name
    FROM public.service_accounts sa
    WHERE sa.id = v_service_account_id
      AND sa.sponsor_user_id = v_user_id
      AND public.service_account_is_active(sa.id);

    IF NOT FOUND THEN
      RETURN;  -- suspended or revoked account: 401 upstream (see service_account_key_refusal)
    END IF;

    v_allowed_company_ids := ARRAY[v_company_id];
    v_read_only_company_ids := CASE
      WHEN EXISTS (
        SELECT 1
        FROM public.api_key_companies akc
        WHERE akc.api_key_id = v_id
          AND akc.company_id = v_company_id
          AND akc.access = 'read'
      ) THEN ARRAY[v_company_id]
    END;
  ELSE
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
  END IF;

  -- Reset the rate-limit window if it is unset or older than one minute.
  IF v_window_start IS NULL OR v_window_start < now() - interval '1 minute' THEN
    UPDATE public.api_keys
       SET request_count = 1,
           rate_limit_window_start = now(),
           last_used_at = now()
     WHERE id = v_id;
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                        v_service_account_id, v_service_account_name,
                        v_agent_identity_id, v_client,
                        v_rate_limit_rpm, NULL::integer;
    RETURN;
  END IF;

  IF v_request_count >= v_rate_limit_rpm THEN
    RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, true, v_scopes, v_mode,
                        v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                        v_service_account_id, v_service_account_name,
                        v_agent_identity_id, v_client,
                        v_rate_limit_rpm,
                        LEAST(60, GREATEST(1, ceil(extract(epoch FROM (v_window_start + interval '1 minute' - now())))))::integer;
    RETURN;
  END IF;

  UPDATE public.api_keys
     SET request_count = request_count + 1,
         last_used_at = now()
   WHERE id = v_id;

  RETURN QUERY SELECT v_user_id, v_company_id, v_id, v_api_key_name, false, v_scopes, v_mode,
                      v_unattended_commit_limit, v_allowed_company_ids, v_read_only_company_ids,
                      v_service_account_id, v_service_account_name,
                      v_agent_identity_id, v_client,
                      v_rate_limit_rpm, NULL::integer;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.validate_and_increment_api_key(text)
  TO service_role;

NOTIFY pgrst, 'reload schema';
