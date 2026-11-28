-- A webshop order the store cancelled can be marked as voided (makulerad).
--
-- The Orders page shows an order the store reports cancelled as Avbruten and
-- offers Markera som makulerad. The void reuses the manual mark of #1879
-- (manually_booked_at/_by): every path that treats a marked row as closed
-- (Att bokföra, the booking and invoice routes, the bulk and day bookings,
-- the open-obligation probes, the sync's removal and freeze rules) then
-- treats a voided row the same way, and the existing unmark clears both. This
-- column says which of the two the mark is: false, the user booked the order
-- outside the integration; true, nothing is booked because the store
-- cancelled the order. The row itself is never deleted.
--
-- A void links no verifikat and no invoice, so the check refuses a voided
-- row that carries one (a manual one, or a booking or invoice that reached
-- the row after the void), and a void without the mark it belongs to.
--
-- No RLS change: the member UPDATE policy already covers the mark and the
-- unmark. No grant: a column of an existing table.

alter table public.webshop_orders
  add column manually_voided boolean not null default false;

alter table public.webshop_orders
  add constraint webshop_orders_void_is_a_mark
  check (
    not manually_voided
    or (
      manually_booked_at is not null
      and manually_booked_journal_entry_id is null
      and journal_entry_id is null
      and invoice_id is null
    )
  );

comment on column public.webshop_orders.manually_voided is
  'True when the manual mark (manually_booked_at/_by) voids the row: the store cancelled the order and nothing is booked (makulerad). False when the mark says the row was booked outside the integration.';

NOTIFY pgrst, 'reload schema';
