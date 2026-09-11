-- list_company_accounts: order the chart by account_number, not sort_order.
--
-- WHY THIS MIGRATION EXISTS
-- -------------------------
-- 20260723170000 ordered the aggregate by (sort_order, id) on the belief that
-- sort_order carries the BAS sequence. It does not: seed_chart_of_accounts()
-- never sets the column, so every seeded system account keeps the default 0
-- (61,355 prod rows on 2026-09-11, all seeded accounts), while most other
-- insert paths store parseInt(account_number). The result was that the ~40
-- seeded accounts came first, in uuid order (a real prod chart started 5800,
-- 3001, 1510, 5460, 6570, 4000 ...), and everything else followed by number.
-- Every consumer shows it: the Kontoplan page keeps this order inside each
-- class, and AccountCombobox groups classes in the order it meets them.
--
-- account_number IS the BAS sequence: four-digit numbers sort in chart order
-- as text, and a longer imported sub-account such as 19301 lands directly
-- after 1930. It is unique per company, so no tiebreaker is needed.
-- sort_order stays on the row (clients read it) but no longer drives order.
--
-- INVARIANTS (unchanged from 20260723170000; do not break these):
--   1. SECURITY INVOKER: the chart_of_accounts RLS select policy keeps
--      applying; the explicit p_company_id filter is defense in depth.
--   2. to_json(c) emits every column: the exact field set select('*')
--      returns. The pg-real parity test locks this.
--   3. Ordering is account_number (unique per company, so deterministic).
--   4. Filters mirror the route: p_active_only true keeps is_active rows
--      only; p_account_class NULL means no class filter.
--
-- pg-test: supabase/migrations/__tests__/list-company-accounts.pg.test.ts

create or replace function public.list_company_accounts(
  p_company_id uuid,
  p_active_only boolean default true,
  p_account_class integer default null
) returns json
language sql stable security invoker
set search_path = public
as $$
  select coalesce(json_agg(to_json(c) order by c.account_number), '[]'::json)
  from public.chart_of_accounts c
  where c.company_id = p_company_id
    and (not p_active_only or c.is_active)
    and (p_account_class is null or c.account_class = p_account_class)
$$;

revoke all on function public.list_company_accounts(uuid, boolean, integer) from public, anon;
grant execute on function public.list_company_accounts(uuid, boolean, integer) to authenticated;
grant execute on function public.list_company_accounts(uuid, boolean, integer) to service_role;

NOTIFY pgrst, 'reload schema';
