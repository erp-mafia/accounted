-- PostgREST computed column: total_amount(journal_entries) = the voucher
-- total, i.e. the sum of the entry's debit lines (equals the credit side on
-- every balanced entry). Lets the verifikat list order by amount server-side
-- via .order('total_amount') without fetching every page.
--
-- LANGUAGE sql + STABLE so PostgREST can inline it; security invoker (the
-- default) so RLS on journal_entry_lines applies to the caller as usual.
-- search_path is pinned empty per project convention (migration
-- 20260304191528); the body fully qualifies every reference.
create or replace function public.total_amount(je public.journal_entries)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(l.debit_amount), 0)
  from public.journal_entry_lines l
  where l.journal_entry_id = je.id
$$;

comment on function public.total_amount(public.journal_entries) is
  'PostgREST computed column: voucher total (sum of debit lines), used to sort the verifikat list by amount.';

grant execute on function public.total_amount(public.journal_entries) to authenticated, service_role;

-- Refresh the PostgREST schema cache so the computed column is orderable
-- immediately, without waiting for a manual restart.
notify pgrst, 'reload schema';
