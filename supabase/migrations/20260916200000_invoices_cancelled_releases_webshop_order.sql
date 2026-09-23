-- Makulering releases the webshop order in the same transaction.
--
-- 20260916190000 made the hard delete of an unnumbered draft release its
-- order through the FK (ON DELETE SET NULL) and left makulering of a
-- numbered draft to an application write after the cancel. Review on the PR
-- (desk crm#56): two statements, so a failed second one reports a
-- successful makulering while the order stays pinned, with no retry or
-- reconciliation path. Move the release into the database so both paths
-- are one rule at one level: an order is released when its invoice stops
-- being a document, atomically with whatever made it stop.
--
--   1. AFTER UPDATE OF status ON invoices: when a row becomes 'cancelled',
--      clear webshop_orders.invoice_id where it points at that row. Runs
--      with the caller's privileges: the member UPDATE policy on
--      webshop_orders covers the same company's rows, and the service role
--      (v1 API, MCP) is unrestricted, so every existing cancel path works.
--   2. The freeze trigger is tightened back: invoice_id may go to null only
--      when the invoice is gone (FK cascade) or 'cancelled' (this trigger).
--      The 'draft' allowance from 20260916190000 existed for the application
--      unlink and is no longer needed; without it a member cannot detach an
--      order from a live draft through PostgREST and end up with two drafts
--      for one order.
--
-- Financial-field freeze and the journal-link rule are unchanged. CREATE OR
-- REPLACE keeps the freeze trigger binding intact.

create or replace function public.release_webshop_order_on_invoice_cancel()
returns trigger
language plpgsql
as $$
begin
  update public.webshop_orders
     set invoice_id = null
   where invoice_id = new.id;
  return null;
end;
$$;

drop trigger if exists release_webshop_order_on_invoice_cancel on public.invoices;
create trigger release_webshop_order_on_invoice_cancel
  after update of status on public.invoices
  for each row
  when (new.status = 'cancelled' and old.status is distinct from 'cancelled')
  execute function public.release_webshop_order_on_invoice_cancel();

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
    -- Unlinking is allowed only once the invoice is no longer a document:
    -- gone (ON DELETE SET NULL of a hard-deleted unnumbered draft) or
    -- makulerad (release_webshop_order_on_invoice_cancel). A live draft
    -- stays linked, and a swap to another invoice is always refused.
    if new.invoice_id is not null then
      raise exception 'webshop_orders row % is linked to an invoice; the link is immutable', old.id
        using errcode = 'P0001';
    end if;
    select status into v_invoice_status
      from public.invoices
      where id = old.invoice_id;
    if v_invoice_status is not null
      and v_invoice_status <> 'cancelled'
    then
      raise exception 'webshop_orders row % is linked to an invoice that is still a document; the link is immutable', old.id
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
