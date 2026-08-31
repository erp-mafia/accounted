-- Approval-authority limit per API key: what an agent may finish WITHOUT a human.
--
-- This is deliberately NOT a write limit and deliberately NOT enforced inside
-- commit_journal_entry. Over the ceiling the agent may still stage a
-- pending_operation; it just may not commit it unattended, so a human approves
-- it in /pending. Nothing is destroyed, no voucher number is burned, and no
-- löpnummer gap is created (BFL 5 kap. 7 §).
--
-- ## Why the limit lives on api_keys and never on company_settings
--
-- company_settings.agent_auto_commit_max_amount existed once
-- (20260501120000) and was dropped four days later (20260505190027). A
-- company-scoped money threshold catches HUMANS too, which is the opposite of
-- the intent. Keyed on the credential, the check can only ever fire for an
-- agent: the gate reads actor.type = 'api_key' plus a non-null limit on that
-- key, and human approvals ({type:'user'}), cron, and every cookie-session
-- route commit with a different actor or none at all.
--
-- ## Why validate_and_increment_api_key returns it
--
-- That function is the one place the database itself verifies which credential
-- is acting: it matches the key hash. A limit returned from there is bound to a
-- DB-verified key rather than asserted by the caller. Passing a key id into
-- commit_journal_entry would have been caller-asserted and unverifiable (the
-- pending-op path runs as service_role, where the tenant guard bypasses by
-- design), while costing a DROP+CREATE on the function that issues every
-- voucher number. Two of that function's seven redefinitions were emergency
-- fixes for PostgREST overload ambiguity; there is no upside left to pay that.
--
-- pg-test: tests/pg/api-key-unattended-commit-limit.pg.test.ts

ALTER TABLE public.api_keys
  ADD COLUMN IF NOT EXISTS unattended_commit_limit numeric(14, 2);

-- The single most important line in this migration.
--
-- A stored 0 would block every commit for that key, and NULL-read-as-0 is the
-- catastrophic failure mode of the whole feature. Making zero unrepresentable
-- at the storage layer means that state cannot be reached even by a bad UI
-- write, a bad PATCH body, or a bad backfill. Absence of a limit is expressed
-- ONLY as NULL, never as 0.
ALTER TABLE public.api_keys
  DROP CONSTRAINT IF EXISTS api_keys_unattended_commit_limit_positive;
ALTER TABLE public.api_keys
  ADD CONSTRAINT api_keys_unattended_commit_limit_positive
  CHECK (unattended_commit_limit IS NULL OR unattended_commit_limit > 0);

COMMENT ON COLUMN public.api_keys.unattended_commit_limit IS
  'SEK ceiling on what this key may commit without human approval. NULL = no limit, and NULL is the only representation of "no limit": zero is forbidden by CHECK because a stored 0 would block every commit. Over the ceiling the agent still stages the operation for a human to approve.';

-- Surface the limit on the one call that already verifies the credential.
--
-- The body below is copied VERBATIM from 20260621130000_api_keys_rotation_grace.sql
-- (the latest definition, which added previous_key_hash rotation grace) with
-- exactly two changes: unattended_commit_limit joins the RETURNS TABLE, and it
-- is selected into a variable and returned in all three RETURN QUERY branches.
-- Copying an older body would silently revert key rotation and lock out every
-- rotating integration.
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
  unattended_commit_limit numeric
)
LANGUAGE plpgsql SECURITY DEFINER AS $$
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
    RETURN;  -- no live match (incl. expired grace) → caller returns 401, as before
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

NOTIFY pgrst, 'reload schema';
