-- PostgREST computed column: display_amount(journal_entries) = the amount the
-- verifikat list shows in its Belopp column (crm#1280), so sorting by Belopp
-- orders by the number on screen. total_amount (migration 20260811100000) is
-- the omslutning, which the column no longer shows for a voucher that records
-- one payment: a reverse-charge bank payment of 200 kr reads 200 kr but sorted
-- as 450 kr.
--
-- Mirrors src/lib/bookkeeping/voucher-display-amount.ts, the single source for
-- the display; tests/pg/journal-entry-display-amount.pg.test.ts runs both over
-- the same voucher shapes and requires them to agree. The rule:
--   * the omslutning (sum of debit lines, rounded to öre) is the fallback;
--   * an opening-balance voucher always shows the omslutning;
--   * money accounts are BAS 19xx plus every ledger the company keeps a cash
--     account on (cash_accounts.ledger_account, e.g. 1686), the same set the
--     list passes the helper;
--   * exactly one line on a money account, with a non-zero net, shows that
--     line's absolute net, unless another class 1 (asset) line sits on the
--     money line's side (a split settlement), which falls back.
-- With exactly one money line, "every other line" is "every non-money line",
-- so one aggregate pass over the lines answers all of it.
--
-- Evaluation: the sort evaluates the function once per row it orders (a
-- company's period, or all its years) before LIMIT, so its cost is per call.
-- No index can serve it (it reads other tables, so it is STABLE, never
-- IMMUTABLE). Under SECURITY INVOKER every RLS-protected table it reads runs
-- its policy's user_company_ids() once per call, and that per-call function
-- startup, not the line scan, is what the sort spends its time on: on prod
-- total_amount already costs about 0.5 ms per row (a 3,000-voucher year about
-- 1.7 s; a 37,000-voucher year exceeds the 8 s statement timeout), and an
-- invoker version of this function reads two such tables (lines and
-- cash_accounts) and measured 1.4x total_amount.
--
-- So it is SECURITY DEFINER with ONE explicit visibility check: it re-reads
-- the stored entry by id and answers only when that entry's company is one of
-- the caller's (user_company_ids(), the journal_entries SELECT policy), and
-- takes the company, source_type and lines from the stored entry, never from
-- the row value passed in. A forged row value (a direct call with another
-- company's entry id) gets NULL, and the caller learns nothing RLS would hide:
-- the lines and cash accounts of an entry it may read are readable to it too.
-- Measured on 20,000 vouchers as a member: 0.4x to 0.6x of total_amount, with
-- results identical to the invoker version. A caller without a user JWT (anon,
-- a bare service-role client) gets NULL; the verifikat list always reads with
-- the user's session. search_path is pinned empty per project convention
-- (migration 20260304191528); the body fully qualifies every reference.
--
-- pg-test: covered-by tests/pg/journal-entry-display-amount.pg.test.ts
create or replace function public.display_amount(je public.journal_entries)
returns numeric
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when e.source_type = 'opening_balance' then t.debit_total
    when t.money_lines <> 1 then t.debit_total
    when round(abs(t.money_net), 2) = 0 then t.debit_total
    when t.money_net > 0 and t.other_asset_debit then t.debit_total
    when t.money_net < 0 and t.other_asset_credit then t.debit_total
    else round(abs(t.money_net), 2)
  end
  from public.journal_entries e
  cross join lateral (
    select
      round(coalesce(sum(l.debit), 0), 2) as debit_total,
      count(*) filter (where l.is_money) as money_lines,
      sum(l.debit - l.credit) filter (where l.is_money) as money_net,
      coalesce(bool_or(not l.is_money and l.debit > 0 and left(l.account_number, 1) = '1'), false)
        as other_asset_debit,
      coalesce(bool_or(not l.is_money and l.credit > 0 and left(l.account_number, 1) = '1'), false)
        as other_asset_credit
    from (
      select
        jel.account_number,
        coalesce(jel.debit_amount, 0) as debit,
        coalesce(jel.credit_amount, 0) as credit,
        (jel.account_number ~ '^19[0-9]{2}$' or ca.id is not null) as is_money
      from public.journal_entry_lines jel
      left join public.cash_accounts ca
        on ca.company_id = e.company_id
       and ca.ledger_account = jel.account_number
      where jel.journal_entry_id = e.id
    ) l
  ) t
  where e.id = je.id
    and e.company_id in (select public.user_company_ids())
$$;

comment on function public.display_amount(public.journal_entries) is
  'PostgREST computed column: the amount the verifikat list shows (the single money line, else the omslutning), used to sort the list by Belopp. Mirrors src/lib/bookkeeping/voucher-display-amount.ts. Security definer with a user_company_ids() check on the stored entry; NULL for an entry the caller cannot read.';

revoke all on function public.display_amount(public.journal_entries) from public, anon;
grant execute on function public.display_amount(public.journal_entries) to authenticated, service_role;

-- Refresh the PostgREST schema cache so the computed column is orderable
-- immediately, without waiting for a manual restart.
notify pgrst, 'reload schema';
