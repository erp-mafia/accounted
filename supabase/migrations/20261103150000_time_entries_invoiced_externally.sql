-- time_entries.invoiced_externally: hours billed outside Accounted (in the
-- system the time report came from, or by hand) before tracking moved here.
-- They count as invoiced everywhere (frozen, never in uninvoiced totals or a
-- draft invoice) without pointing at an Accounted invoice, so no invoice row
-- has to be invented for history. An entry is invoiced either here
-- (invoice_id) or outside (this flag), never both.
--
-- pg-test: tests/pg/time-entries.pg.test.ts.
ALTER TABLE public.time_entries
  ADD COLUMN invoiced_externally boolean NOT NULL DEFAULT false;

ALTER TABLE public.time_entries
  ADD CONSTRAINT time_entries_invoiced_once
  CHECK (NOT (invoiced_externally AND invoice_id IS NOT NULL));

NOTIFY pgrst, 'reload schema';
