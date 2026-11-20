-- Drop seven functions nothing calls any more but that signed-in users could
-- still call through PostgREST (POST /rest/v1/rpc/<name>).
-- pg-test: tests/pg/drop-dead-callable-functions.pg.test.ts
--
-- Each one kept its EXECUTE grant to authenticated after its last caller went
-- away, and a grant on a dead function is a door nobody watches: no app path
-- exercises it, so a regression in its guard or a misuse shows up nowhere.
-- Six are SECURITY DEFINER. Verified before this migration: no rpc() call in
-- src/ or scripts/, no other function body, policy, view, default or check
-- that references them, and no PostgREST call to any of them in the edge
-- logs since 2026-09-11 except list_peppol_delivery_summaries, last called
-- 2026-09-26 before its route moved off it.
--
--   reserve_voucher_range / release_voucher_range: unused since the atomic
--     SIE import (#860). Any member could advance or roll back a voucher
--     sequence, which leaves voucher-number gaps (BFNAR 2013:2). Supersedes
--     the revoke-only fix on branch fix/revoke-voucher-range-rpcs.
--   list_peppol_delivery_summaries: the deliveries route reads
--     peppol_deliveries with the service client since #3098.
--   create_team_with_owner: no caller; let any signed-in user create any
--     number of teams. ensure_user_team() is the live path and stays.
--   validate_version_chain: never called by the app.
--   company_has_capability: the capability gate reads grant rows through
--     company_capability_grant_rows and decides in TypeScript.
--   normalize_country_code: existed for the one-off country backfill in
--     20260903173000; the TypeScript normalizeCountryCode is the only live
--     copy.

DROP FUNCTION IF EXISTS public.reserve_voucher_range(uuid, uuid, text, integer);
DROP FUNCTION IF EXISTS public.release_voucher_range(uuid, uuid, text, integer, integer);
DROP FUNCTION IF EXISTS public.list_peppol_delivery_summaries(uuid, uuid);
DROP FUNCTION IF EXISTS public.create_team_with_owner(text);
DROP FUNCTION IF EXISTS public.validate_version_chain(uuid);
DROP FUNCTION IF EXISTS public.company_has_capability(uuid, text);
DROP FUNCTION IF EXISTS public.normalize_country_code(text);

NOTIFY pgrst, 'reload schema';
