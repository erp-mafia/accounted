-- API keys can no longer be created or changed from a session that skipped
-- MFA.
-- pg-test: tests/pg/api-keys-require-mfa-session.pg.test.ts
--
-- The hole: `authenticated` holds INSERT
-- and UPDATE on public.api_keys, and the permissive policies only ask for
-- user_id = auth.uid() and an owner/admin role. MFA is enforced in the app
-- (withRouteContext, the middleware), never in the database. Whoever knows
-- only the password of an owner or admin who HAS enrolled a factor can take
-- an AAL1 token straight from GoTrue (password grant, public anon key) and
-- POST a row with a key_hash of their choosing to /rest/v1/api_keys. That
-- gnubok_sk_ key then works on /api/v1 and MCP (API-key surfaces are exempt
-- from the MFA gate) and survives a password change. UPDATE at AAL1 is as
-- bad: it can clear revoked_at on a leaked key or widen its scopes.
--
-- Why restrictive policies and not a REVOKE: no app path INSERTs through a
-- user session any more (the settings route and the MCP OAuth token route
-- mint through the service-role RPC create_api_key_with_allowlist, service
-- accounts through create_service_account_key), but two UPDATEs still run on
-- the session client and need the grant: the revoke in DELETE
-- /api/settings/api-keys/[id] and the unattended_commit_limit in PATCH on the
-- same route. Revoking UPDATE would mean moving both to the service role and
-- re-implementing the admin gate RLS gives them today. So the grant stays and
-- two RESTRICTIVE policies require what the app already requires: a session
-- of a user with a verified factor must be AAL2 (Supabase's documented MFA
-- pattern). Users without a factor are unaffected, and so is every
-- service-role and SECURITY DEFINER writer (RLS does not apply to them).
--
-- Revoking stays allowed at AAL1: a row that ends up revoked can never
-- authenticate again (validate_and_increment_api_key requires
-- revoked_at IS NULL, and clearing it is the one change that needs AAL2), and
-- users the app exempts from the step-up (BankID-linked, self-hosted) must
-- keep the means to kill a key. The check is WITH CHECK only, so a refused
-- write raises 42501 instead of silently matching zero rows.
--
-- The factor lookup is a SECURITY DEFINER helper: `authenticated` has no
-- privilege on auth.mfa_factors (only postgres and supabase_auth_admin do),
-- so a policy that queried it directly would fail for every user session.
-- Scoped to api_keys on purpose; MFA for the rest of the schema stays
-- application-side.

CREATE FUNCTION public.session_is_mfa_assured()
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_claims jsonb := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_uid uuid := auth.uid();
BEGIN
  -- Reaching AAL2 takes a verified challenge on a verified factor.
  IF v_claims ->> 'aal' = 'aal2' THEN
    RETURN true;
  END IF;

  -- No user, nothing to step up (the permissive policies refuse a NULL
  -- uid on their own). No factor table means no GoTrue, hence no factors:
  -- the pg-real replay and a fresh self-hosted database before GoTrue boots.
  IF v_uid IS NULL OR to_regclass('auth.mfa_factors') IS NULL THEN
    RETURN true;
  END IF;

  -- Below AAL2: assured only while the user has no verified factor to step
  -- up with, the same rule as requireAuth (lib/auth/require-auth.ts).
  RETURN NOT EXISTS (
    SELECT 1
      FROM auth.mfa_factors f
     WHERE f.user_id = v_uid
       AND f.status = 'verified'
  );
END;
$$;

REVOKE ALL ON FUNCTION public.session_is_mfa_assured() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.session_is_mfa_assured() TO authenticated, service_role;

CREATE POLICY api_keys_insert_requires_mfa ON public.api_keys
  AS RESTRICTIVE
  FOR INSERT
  TO authenticated
  WITH CHECK ((SELECT public.session_is_mfa_assured()));

CREATE POLICY api_keys_update_requires_mfa ON public.api_keys
  AS RESTRICTIVE
  FOR UPDATE
  TO authenticated
  WITH CHECK (revoked_at IS NOT NULL OR (SELECT public.session_is_mfa_assured()));

NOTIFY pgrst, 'reload schema';
