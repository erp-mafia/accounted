-- An issued invoice keeps the öresavrundning it was issued with (crm#1487).
-- pg-test: tests/pg/invoices-freeze-ore-rounding.pg.test.ts
--
-- invoices.ore_rounding is the per-invoice choice; NULL inherits
-- company_settings.ore_rounding when the invoice is rendered
-- (getDisplayTotal). That is right for a draft, which shows what it will ask
-- for, and wrong for an issued invoice: every create path that omits the field
-- (v1 and MCP without ore_rounding, imports, every credit note) left NULL on
-- the issued row, so its "Att betala" followed the company setting of the day.
-- A later toggle moved an issued invoice from 4,00 to 4,38 on its PDF, in the
-- API, in the payment proposal and on its credit note.
--
-- The issue verifikat cannot tell what was issued: it books the exact total on
-- 1510 with rounding on or off (öresavrundning is booked on 3740 only when the
-- payment arrives). The company_settings audit trail can: audit_log holds every
-- company_settings state since before the first invoice that carried this
-- column, so the setting in effect at issue is known.
--
-- 1. Backfill: an issued invoice without its own choice, where the choice
--    changes the amount (SEK with öre), gets the company setting in effect at
--    issue. Issue is the first delivery or the issue verifikat, whichever came
--    first, else the row's creation. For every row the backfill touched
--    when this was written, that setting equals today's company setting, so
--    nothing printed or reported changes; the rows only stop following future
--    toggles. Whole-krona and foreign-currency rows are left alone: no setting
--    changes their amount, and the trigger below freezes them when their status
--    next moves. Companies archived by a migration reset are skipped (their rows
--    are immutable).
-- 2. Trigger: the choice freezes when an invoice leaves draft, from the company
--    setting when the writer left it NULL, and an issued invoice keeps it. A
--    draft (also a credit note put back to draft for a retry) stays free.

update public.invoices i
set ore_rounding = coalesce(
  (
    select (a.new_state ->> 'ore_rounding')::boolean
    from public.audit_log a
    where a.table_name = 'company_settings'
      and a.company_id = s.company_id
      and a.action in ('INSERT', 'UPDATE')
      and a.new_state ? 'ore_rounding'
      and a.created_at <= s.issued_at
    order by a.created_at desc
    limit 1
  ),
  (select cs.ore_rounding from public.company_settings cs where cs.company_id = s.company_id),
  true
)
from (
  select
    x.id,
    x.company_id,
    coalesce(
      least(
        (select min(d.created_at) from public.invoice_deliveries d where d.invoice_id = x.id),
        (select je.created_at from public.journal_entries je where je.id = x.journal_entry_id)
      ),
      x.created_at
    ) as issued_at
  from public.invoices x
  where x.ore_rounding is null
    and coalesce(x.status, 'draft') <> 'draft'
    and x.currency = 'SEK'
    and x.total <> round(x.total)
    and not exists (
      select 1 from public.company_migration_resets m where m.source_company_id = x.company_id
    )
) s
where s.id = i.id;

create or replace function public.invoices_freeze_ore_rounding()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- A draft follows the company setting until it is issued.
  if coalesce(new.status, 'draft') = 'draft' then
    return new;
  end if;
  -- Issued: the choice it was issued with stands.
  if tg_op = 'UPDATE' and coalesce(old.status, 'draft') <> 'draft' and old.ore_rounding is not null then
    new.ore_rounding := old.ore_rounding;
    return new;
  end if;
  -- Issued now, or inserted already issued, without a choice: the company's.
  if new.ore_rounding is null then
    new.ore_rounding := coalesce(
      (select cs.ore_rounding from public.company_settings cs where cs.company_id = new.company_id),
      true
    );
  end if;
  return new;
end;
$$;

comment on function public.invoices_freeze_ore_rounding() is
  'Freezes invoices.ore_rounding when an invoice leaves draft (the company setting when the writer left it NULL) and keeps it on an issued invoice (crm#1487).';

create trigger invoices_freeze_ore_rounding
  before insert or update of status, ore_rounding on public.invoices
  for each row execute function public.invoices_freeze_ore_rounding();

comment on column public.invoices.ore_rounding is
  'Per-invoice öresavrundning choice (display-only). On a draft NULL inherits company_settings.ore_rounding; it freezes when the invoice is issued (invoices_freeze_ore_rounding). Does not affect stored amounts or journal entries.';
