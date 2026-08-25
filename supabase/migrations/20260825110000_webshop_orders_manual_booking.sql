-- Manual booking mark for webshop orders (issue #1879).
--
-- Orders booked by hand BEFORE the integration was connected sit in the
-- "Att bokfora" list forever: the only exits are the book and create-invoice
-- routes. These columns add a third, non-accounting exit: the user marks the
-- row as already handled outside the integration, optionally pointing at the
-- existing verifikat.
--
-- Deliberately separate from journal_entry_id: that column is the claim the
-- booking route takes atomically and the freeze trigger treats it as "this
-- row PRODUCED that entry" (financial fields freeze, link becomes immutable
-- once posted). A manual mark produced nothing; it is a user assertion with
-- an optional soft reference, so it stays reversible (unmark) and does not
-- freeze the row. The book/create-invoice routes refuse marked rows
-- application-side, mirroring the legacy_transaction_id double-booking lock.
--
-- No RLS change: the existing member UPDATE policy already covers the mark/
-- unmark writes. No audit trigger (consistent with the table: accounting-
-- relevant events are audited on journal_entries/invoices; the mark keeps
-- who/when on the row itself via manually_booked_by/_at).

alter table public.webshop_orders
  add column manually_booked_at timestamptz,
  add column manually_booked_by uuid references auth.users(id) on delete set null,
  add column manually_booked_journal_entry_id uuid references public.journal_entries(id) on delete set null;

comment on column public.webshop_orders.manually_booked_at is
  'When the user marked this row as already booked/handled outside the integration; null = not marked. Marked rows leave the to-book list and the book/create-invoice routes refuse them.';
comment on column public.webshop_orders.manually_booked_by is
  'User who marked the row as manually booked.';
comment on column public.webshop_orders.manually_booked_journal_entry_id is
  'Optional user-chosen reference to the existing verifikat that covers this order. Informational link only: the entry was created outside the order flow, so this never freezes the row.';

NOTIFY pgrst, 'reload schema';
