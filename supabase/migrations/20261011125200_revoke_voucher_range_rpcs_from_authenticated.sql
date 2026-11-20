-- reserve_voucher_range and release_voucher_range are no longer callable by
-- end-user sessions.
--
-- Both were the SIE import's batch-numbering helpers. Since the atomic SIE
-- import (#860, 2026-07-16) import_sie_journal_entries numbers vouchers itself
-- and nothing in the app calls either function. They kept EXECUTE for
-- `authenticated`, so any signed-in member could still call
-- /rest/v1/rpc/reserve_voucher_range on their own company and push the voucher
-- sequence forward, burning numbers that then show up as gaps
-- (BFNAR 2013:2, voucher_gap_explanations).
--
-- Only `authenticated` loses EXECUTE. PUBLIC and anon were revoked in
-- 20260619130100; service_role keeps it (no caller today, and service-role
-- code is trusted). The function bodies are unchanged.
--
-- pg-test: covered-by tests/pg/securitydefiner_write_rpc_tenant_guards.pg.test.ts

REVOKE EXECUTE ON FUNCTION public.reserve_voucher_range(uuid, uuid, text, integer) FROM authenticated;
REVOKE EXECUTE ON FUNCTION public.release_voucher_range(uuid, uuid, text, integer, integer) FROM authenticated;
