-- verified_actor_disagreements gains a reason: a signed-in user's commit
-- that asserts a key actor (service account, API key, MCP OAuth connection).
-- pg-test: tests/pg/journal-entry-verified-principal.pg.test.ts
--
-- Every door that acts for a key runs as the service role: the v1 API
-- (withApiV1) and the MCP server (handleMcpRequest) validate the gnubok_sk_
-- key themselves and query through createServiceClientNoCookies(), so their
-- commits are stamped committed_auth_role = 'service_role'
-- (20261016110000). A commit stamped 'authenticated' (a person's JWT) that
-- still names service_account, api_key or mcp_oauth as its actor is an
-- assertion no legitimate path makes, the same shape as the existing cron and
-- system rule. It is listed here, one row per commit and reason, before
-- anyone decides to refuse it:
--
--   end_user_asserted_key_actor
--       role authenticated, committed_actor_type service_account, api_key or
--       mcp_oauth.
--
-- The existing three reasons are unchanged. agent_chat is not in the new
-- list: the in-app assistant commits on the person's own session.
--
-- Body from the latest definition, 20261016110100_verified_actor_disagreements
-- (the only one), with that one branch added to the lateral reason set.
-- Still LANGUAGE sql, STABLE, SECURITY INVOKER (no SECURITY DEFINER), the
-- same signature and result columns, so CREATE OR REPLACE keeps it in place;
-- the grants are restated anyway: service_role only, never the Data API
-- end-user roles. Read-only: nothing is written and no commit is refused.

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
      SELECT 'end_user_asserted_key_actor'
       WHERE je.committed_auth_role = 'authenticated'
         AND je.committed_actor_type IN ('service_account', 'api_key', 'mcp_oauth')
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
  'Read-only diagnostic: commits whose asserted actor (committed_actor_type, user_id) disagrees with the principal the database verified (committed_auth_role, committed_auth_uid), one row per commit and reason: end_user_asserted_machine_actor (cron/system), end_user_asserted_key_actor (service_account/api_key/mcp_oauth), verified_uid_differs_from_entry_user, end_user_without_uid. Sizes the planned refusal rules before any is enabled. service_role only.';

NOTIFY pgrst, 'reload schema';
