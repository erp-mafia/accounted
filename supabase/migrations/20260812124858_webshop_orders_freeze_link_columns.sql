-- Freeze v2: protect the booking/invoice LINK columns themselves.
--
-- v1 (20260811073315) froze the financial fields once journal_entry_id or
-- invoice_id was set, but the link columns were not in the protected list:
-- a member could clear the link in one statement and mutate the financials
-- in the next (review finding, PR #1525). Now:
--
-- - invoice_id: immutable once set. No flow legitimately unlinks an invoice
--   (the create-invoice rollback deletes a draft it never managed to link).
-- - journal_entry_id: may change only while the referenced entry is NOT
--   posted. The booking route's failure path unlinks its cancelled draft
--   (status stays 'draft'); once the entry is posted the link is underlag
--   and only storno may follow.
--
-- CREATE OR REPLACE keeps the trigger binding from v1 intact.

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

  if old.journal_entry_id is not null or old.invoice_id is not null then
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
      raise exception 'webshop_orders row % is booked/invoiced; financial fields are frozen (use storno)', old.id
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
