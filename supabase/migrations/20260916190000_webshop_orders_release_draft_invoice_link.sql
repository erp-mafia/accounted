-- Release the order-to-invoice link when the draft invoice goes away.
--
-- webshop_orders.invoice_id was created (20260811073315) as a plain
-- REFERENCES with no ON DELETE action, and freeze v2 (20260812124858) made a
-- set invoice_id immutable ("no flow legitimately unlinks an invoice"). Both
-- predate draft deletion for invoices. Today an unnumbered draft created from
-- a webshop order cannot be removed at all: DELETE /api/invoices/[id] fails
-- with 23503 (webshop_orders_invoice_id_fkey), and a numbered draft that is
-- makulerad leaves the order pinned to a cancelled invoice forever, so it can
-- neither be booked nor invoiced again (desk crm#56).
--
-- Two changes, one rule: an order is released when its invoice stops being
-- an issued document.
--
--   1. The FK becomes ON DELETE SET NULL. An unnumbered draft (no F-number
--      consumed, ML 17 kap 24 paragraf gap rule does not apply) is hard
--      deleted by lib/invoices/delete-draft-invoice.ts; the referential
--      action clears the link in the same statement, so no caller can forget
--      it. Issued invoices are never deleted (BFL), so the action never fires
--      for them.
--   2. The freeze trigger allows invoice_id to go to null when the invoice it
--      pointed at no longer exists (the cascade above: the parent row is gone
--      by the time the referential action updates the order) or is still a
--      draft / has been makulerad (the application unlinks after cancelling a
--      numbered draft). A link to a sent or paid invoice stays immutable, and
--      relinking to a different invoice is still refused: that would let one
--      order carry two documents.
--
-- The financial-field freeze and the journal-link rule are unchanged.
-- CREATE OR REPLACE keeps the trigger binding intact.

alter table public.webshop_orders
  drop constraint webshop_orders_invoice_id_fkey;

alter table public.webshop_orders
  add constraint webshop_orders_invoice_id_fkey
  foreign key (invoice_id) references public.invoices(id) on delete set null;

create or replace function public.enforce_webshop_order_financial_freeze()
returns trigger
language plpgsql
as $$
declare
  v_entry_status text;
  v_invoice_status text;
begin
  -- Link-column protection runs FIRST: it applies even when the row was
  -- frozen by the other link.
  if old.invoice_id is not null
    and new.invoice_id is distinct from old.invoice_id
  then
    -- Unlinking is allowed only when the invoice is no longer an issued
    -- document: gone (ON DELETE SET NULL of a hard-deleted unnumbered draft),
    -- still a draft, or makulerad. Anything else, including a swap to another
    -- invoice, stays refused.
    if new.invoice_id is not null then
      raise exception 'webshop_orders row % is linked to an invoice; the link is immutable', old.id
        using errcode = 'P0001';
    end if;
    select status into v_invoice_status
      from public.invoices
      where id = old.invoice_id;
    if v_invoice_status is not null
      and v_invoice_status not in ('draft', 'cancelled')
    then
      raise exception 'webshop_orders row % is linked to an issued invoice; the link is immutable', old.id
        using errcode = 'P0001';
    end if;
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
