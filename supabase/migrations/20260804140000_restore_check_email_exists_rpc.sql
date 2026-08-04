-- =============================================================================
-- Restore public.check_email_exists
-- =============================================================================
--
-- This function shipped in PR #229 and was then lost in the #244 migration
-- consolidation before it ever reached prod: it exists in no deployed
-- environment today. The invite flow still calls it via the service client
-- (app/api/team/accept/route.ts and app/api/company/members/invite/route.ts),
-- so on every deployment the RPC error is silently swallowed, the
-- "already has an account" answer resolves to null, and the invite page
-- routes even existing-account invitees toward /register.
--
-- Restored exactly as originally shipped. SECURITY DEFINER because it reads
-- auth.users; execution is service-role only (the two routes above call it
-- through createServiceClient()) so it cannot be used for email enumeration
-- by anon or authenticated clients.

CREATE OR REPLACE FUNCTION public.check_email_exists(email_to_check text)
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM auth.users WHERE lower(email) = lower(email_to_check)
  );
$$;

-- Belt and braces: PUBLIC covers the default grant, but revoke the two
-- browser-facing roles explicitly as well in case a future default-privilege
-- change re-grants them.
REVOKE EXECUTE ON FUNCTION public.check_email_exists(text) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.check_email_exists(text) FROM anon;
REVOKE EXECUTE ON FUNCTION public.check_email_exists(text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.check_email_exists(text) TO service_role;

NOTIFY pgrst, 'reload schema';
