-- RPC: get_account_usage_counts — per-account posting counts for the
-- kontoplan cleanup flow ("Rensa oanvända konton").
--
-- PostgREST cannot GROUP BY through supabase-js, and paging every
-- journal_entry_line through fetchAllRows to count in JS does not scale for
-- companies with years of history. One SQL aggregate answers "which accounts
-- have ever been posted to, and how many times" in a single round trip.
--
-- Usage covers ALL journal entries regardless of status: a draft line still
-- references the account, so it must count as "used" for deletion purposes.
-- Opening balances need no special case — IB is booked as a verifikat
-- (source_type 'opening_balance'), so its lines are counted here too.
--
-- SECURITY INVOKER: journal_entries/journal_entry_lines RLS is company-scoped
-- via user_company_ids() (20260330130000), so the caller's own membership
-- bounds what is counted; a non-member calling with a foreign company id gets
-- zero rows, not an error.
--
-- pg-test: tests/pg/account-usage-counts-rpc.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_account_usage_counts(p_company_id uuid)
RETURNS TABLE (account_number text, usage_count bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT l.account_number, count(*)::bigint AS usage_count
  FROM public.journal_entry_lines l
  JOIN public.journal_entries je ON je.id = l.journal_entry_id
  WHERE je.company_id = p_company_id
  GROUP BY l.account_number;
$$;

REVOKE ALL ON FUNCTION public.get_account_usage_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_account_usage_counts(uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
