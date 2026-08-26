-- Freeze v3: financial fields are also frozen while a row is MANUALLY marked
-- as booked outside the integration (issue #1879, review finding on PR #1895).
--
-- v2 (20260812124858) froze financials once journal_entry_id/invoice_id was
-- set. The manual mark (manually_booked_at) got the same protection only in
-- application code (lib/webshop-orders/ingest.ts isFrozen): any other write
-- path (browser-client PATCH through the member UPDATE policy, a future
-- endpoint, an ad-hoc script) could still silently mutate total/line_items
-- under the user's "this row is covered by verifikat X" assertion. Now the
-- trigger holds the same line: while marked, the financial fields are
-- immutable at the DB level; sync's safe-field updates (status, refund
-- summary, labels, remote_changed_after_freeze) still pass, and clearing the
-- mark itself stays allowed (the manual columns are not in the protected
-- list), which is exactly the unmark route's escape hatch: unmark first,
-- then the row is fully mutable again.
--
-- The link-column protections from v2 are unchanged. CREATE OR REPLACE keeps
-- the trigger binding intact.

create or replace function public.enforce_webshop_order_financial_freeze()
returns trigger
language plpgsql
as $$
declare
  v_entry_status text;
begin
  -- Link-column protection runs FIRST: it applies even when the row was
  -- frozen by the other link.
  if old.invoice_id is not null
    and new.invoice_id is distinct from old.invoice_id
  then
    raise exception 'webshop_orders row % is linked to an invoice; the link is immutable', old.id
      using errcode = 'P0001';
  end if;

  if old.journal_entry_id is not null
    and new.journal_entry_id is distinct from old.journal_entry_id
  then
    select status into v_entry_status
      from public.journal_entries
      where id = old.journal_entry_id;
    if v_entry_status is null or v_entry_status = 'posted' then
      raise exception 'webshop_orders row % is booked; the journal link is immutable (use storno)', old.id
        using errcode = 'P0001';
    end if;
  end if;

  if old.journal_entry_id is not null
    or old.invoice_id is not null
    or old.manually_booked_at is not null
  then
    if new.total is distinct from old.total
      or new.total_tax is distinct from old.total_tax
      or new.total_sek is distinct from old.total_sek
      or new.exchange_rate is distinct from old.exchange_rate
      or new.currency is distinct from old.currency
      or new.vat_breakdown is distinct from old.vat_breakdown
      or new.line_items is distinct from old.line_items
      or new.order_date is distinct from old.order_date
      or new.paid_date is distinct from old.paid_date
      or new.is_paid is distinct from old.is_paid
      or new.payment_method is distinct from old.payment_method
      or new.external_id is distinct from old.external_id
      or new.platform_order_id is distinct from old.platform_order_id
    then
      raise exception 'webshop_orders row % is booked/invoiced/marked as booked; financial fields are frozen (unmark or use storno)', old.id
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
