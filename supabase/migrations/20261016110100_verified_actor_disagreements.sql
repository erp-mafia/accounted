-- Where the asserted actor and the verified principal of a commit disagree
-- (read-only diagnostic; building blocks plan, Phase 1).
--
-- 20261016110000 stamps every commit with the principal the database itself
-- verified (journal_entries.committed_auth_role, committed_auth_uid) beside
-- the actor the application asserts (committed_actor_type,
-- committed_actor_label, and the user id it wrote as user_id). Nothing
-- refuses a commit yet. Before anyone turns refusals on, the data has to show
-- that they would only stop what should never happen. This function lists
-- the commits each planned rule would have refused, one row per commit and
-- reason:
--
--   end_user_asserted_machine_actor
--       a signed-in user's request (role authenticated) asserted a cron or
--       system actor: no cron or system path runs on a user's JWT.
--   verified_uid_differs_from_entry_user
--       the verified auth.uid() is not the user id the verifikat records as
--       its user (user_id, which the application asserts when it creates the
--       draft). A colleague posting another user's draft lands here too:
--       that is what the data must size before this rule can refuse.
--   end_user_without_uid
--       role authenticated but no uid could be read: the stamp itself could
--       not see the JWT subject (claims unreadable). Never expected.
--
-- Only commits stamped since 20261016110000 are considered; older rows have
-- no verified principal. SECURITY INVOKER and executable by service_role
-- only (operators, never the Data API roles): it reads every company's
-- verifikat. Without p_company_id it reads the whole table; pass a company
-- or p_since to narrow it.
--
--   SELECT reason, count(*) FROM public.verified_actor_disagreements(
--     p_since => now() - interval '30 days') GROUP BY reason;
--
-- pg-test: tests/pg/journal-entry-verified-principal.pg.test.ts

CREATE OR REPLACE FUNCTION public.verified_actor_disagreements(
  p_company_id uuid DEFAULT NULL,
  p_since      timestamptz DEFAULT NULL
)
RETURNS TABLE (
  journal_entry_id     uuid,
  company_id           uuid,
  voucher_series       text,
  voucher_number       integer,
  committed_at         timestamptz,
  asserted_actor_type  text,
  asserted_actor_label text,
  asserted_user_id     uuid,
  verified_role        text,
  verified_uid         uuid,
  reason               text
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT je.id,
         je.company_id,
         je.voucher_series,
         je.voucher_number,
         je.committed_at,
         je.committed_actor_type,
         je.committed_actor_label,
         je.user_id,
         je.committed_auth_role,
         je.committed_auth_uid,
         r.reason
    FROM public.journal_entries je
    CROSS JOIN LATERAL (
      SELECT 'end_user_asserted_machine_actor'::text AS reason
       WHERE je.committed_auth_role = 'authenticated'
         AND je.committed_actor_type IN ('cron', 'system')
      UNION ALL
      SELECT 'verified_uid_differs_from_entry_user'
       WHERE je.committed_auth_uid IS NOT NULL
         AND je.committed_auth_uid IS DISTINCT FROM je.user_id
      UNION ALL
      SELECT 'end_user_without_uid'
       WHERE je.committed_auth_role = 'authenticated'
         AND je.committed_auth_uid IS NULL
    ) r
   WHERE je.committed_auth_role IS NOT NULL
     AND (p_company_id IS NULL OR je.company_id = p_company_id)
     AND (p_since IS NULL OR je.committed_at >= p_since)
   ORDER BY je.committed_at, je.id, r.reason;
$$;

REVOKE ALL ON FUNCTION public.verified_actor_disagreements(uuid, timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verified_actor_disagreements(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.verified_actor_disagreements(uuid, timestamptz) IS
  'Read-only diagnostic: commits whose asserted actor (committed_actor_type, user_id) disagrees with the principal the database verified (committed_auth_role, committed_auth_uid), one row per commit and reason. Sizes the planned refusal rules before any is enabled. service_role only.';

NOTIFY pgrst, 'reload schema';
