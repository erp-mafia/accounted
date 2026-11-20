-- PostgREST computed column: is_booked(transactions) = the bank row is
-- anchored to a verifikat, i.e. public.is_transaction_booked (migration
-- 20260529120000): the journal_entry_id pointer, a transaction_voucher_links
-- row (bulk booking, 1:N split), an invoice_payments row or a
-- supplier_invoice_payments row (batch allocation).
--
-- Why: the v1 transaction list filtered status=booked|unbooked on the
-- journal_entry_id pointer alone, because the other three anchors live in
-- other tables that a cursor-paginated PostgREST query cannot filter on. A
-- bulk-booked or allocation-settled row read as "unbooked" there, while the
-- MCP list, the period-lock guard and the VAT close check (lib/transactions/
-- unbooked.ts) subtracted the anchors in memory. With the rule on the row,
-- every list filters with .eq('is_booked', ...) and the predicate stays the
-- one SQL definition: this function only calls it.
--
-- LANGUAGE sql + STABLE; security invoker (the default) so RLS on the anchor
-- tables applies to the caller as usual. search_path is pinned empty per
-- project convention (migration 20260304191528, precedent
-- 20260811100000_journal_entry_total_amount); the body is fully qualified.
create or replace function public.is_booked(t public.transactions)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.is_transaction_booked(t.id)
$$;

comment on function public.is_booked(public.transactions) is
  'PostgREST computed column: the bank row is anchored to a verifikat (public.is_transaction_booked). Lets a paginated list filter booked / unbooked server-side.';

grant execute on function public.is_booked(public.transactions) to authenticated, service_role;

-- Refresh the PostgREST schema cache so the computed column is filterable
-- immediately, without waiting for a manual restart.
notify pgrst, 'reload schema';
