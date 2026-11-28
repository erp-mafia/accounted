-- invoices.late_interest_invoice_id (20261127160500): the index its foreign
-- key needs, so deleting an invoice (a draft räntefaktura, a migration
-- reset) finds the rows to set NULL without reading the whole table. Partial:
-- only invoices whose interest a räntefaktura charges carry a value.
--
-- Built CONCURRENTLY so invoicing keeps writing during the build, as in
-- 20261120141500; a half-built index left by a cancelled run is dropped
-- first (on a normal run the drop finds nothing).
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.

DROP INDEX IF EXISTS public.invoices_late_interest_invoice_id_idx;

CREATE INDEX CONCURRENTLY invoices_late_interest_invoice_id_idx
  ON public.invoices (late_interest_invoice_id)
  WHERE late_interest_invoice_id IS NOT NULL;
