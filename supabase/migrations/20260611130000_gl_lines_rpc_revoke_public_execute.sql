-- Migration: least-privilege EXECUTE on the GL-line read RPCs.
--
-- Follow-up to 20260611120000_gl_lines_rpc_tenant_guard.sql. That migration's
-- in-function guard already closes the DATA leak — an anon/authenticated caller
-- gets zero rows for a company it doesn't belong to. This migration additionally
-- removes the unnecessary EXECUTE *privilege* for unauthenticated callers
-- (defense in depth / least privilege): anon should not even be able to invoke a
-- financial-ledger RPC.
--
-- Why REVOKE FROM anon alone is NOT enough: Supabase grants EXECUTE on new public
-- functions to PUBLIC *and* explicitly to anon/authenticated/service_role. anon
-- is a member of PUBLIC, so the PUBLIC grant keeps it callable even after its own
-- grant is revoked. Revoke both PUBLIC and anon, then (re)assert the only two
-- legitimate callers:
--   * authenticated — the API routes call via the user's session; the in-
--     function tenant guard scopes them to their own companies.
--   * service_role  — the enable-banking reconciliation cron.

REVOKE EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.get_unlinked_gl_lines(uuid, text, date, date) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_account_gl_lines_for_matching(uuid, text, date, date, boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
