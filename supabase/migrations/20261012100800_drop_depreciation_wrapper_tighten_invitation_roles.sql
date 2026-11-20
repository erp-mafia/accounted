-- Two leftovers whose job is now done by something simpler.
--
-- 1. commit_asset_depreciation(uuid, uuid, uuid, uuid, numeric, text, text)
--    was kept by 20260923142743 for old clients that could not describe an
--    opening balance; it only forwards to the 9-argument form with opening
--    amount 0 and no opening date. The app has called the 9-argument form
--    with named arguments since e4e7ccb25 (createAssetDepreciationEntry in
--    src/lib/bookkeeping/engine.ts), and no SQL function calls the wrapper.
--    Dropping it leaves one signature, so a caller that omits the opening
--    snapshot is refused instead of silently posting with opening 0.
--
-- 2. Invitations never mint owners. 20260902093000 enforced that for
--    company_invitations with a trigger because the CHECK still listed
--    'owner'. A CHECK that lists only the grantable roles says the same thing
--    in one place; the trigger and its function go. team_invitations gets the
--    same CHECK: its accept path (src/lib/company/pending-invites.ts) already
--    caps the role at admin, the table did not.
--    Writers: src/app/api/company/members/invite/route.ts (admin, member,
--    viewer) and src/app/api/team/invite/route.ts (admin, member). Both CHECKs
--    validate the existing rows, so an unexpected role fails this migration
--    instead of passing silently.
--
-- pg tests: tests/pg/asset-depreciation-atomic.pg.test.ts (signature gone),
-- tests/pg/security-role-gates-and-posting-integrity.pg.test.ts (23514 on
-- owner invitations, the grantable roles still insert).

DROP FUNCTION IF EXISTS public.commit_asset_depreciation(uuid, uuid, uuid, uuid, numeric, text, text);

DROP TRIGGER IF EXISTS enforce_company_invitation_role ON public.company_invitations;
DROP FUNCTION IF EXISTS public.enforce_company_invitation_role();

ALTER TABLE public.company_invitations DROP CONSTRAINT company_invitations_role_check;
ALTER TABLE public.company_invitations ADD CONSTRAINT company_invitations_role_check
  CHECK (role IN ('admin', 'member', 'viewer'));

ALTER TABLE public.team_invitations DROP CONSTRAINT team_invitations_role_check;
ALTER TABLE public.team_invitations ADD CONSTRAINT team_invitations_role_check
  CHECK (role IN ('admin', 'member'));

NOTIFY pgrst, 'reload schema';
