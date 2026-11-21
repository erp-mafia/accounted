-- invoices: one company's invoices newest first, for the Kundfakturor list.
--
-- The list reads a company's invoices ordered by invoice_date DESC, id DESC,
-- a thousand rows a page, now for the chosen fiscal year. The only index on
-- company_id made every page sort all of the company's invoices first
-- (about 280 ms a page for the largest register, 31 600 invoices).
--
-- Built CONCURRENTLY so invoicing keeps writing during the build; the CLI
-- that applies migrations runs it outside the migration's transaction, and a
-- half-built index left by a cancelled run is dropped first (on a normal
-- run the drop finds nothing).
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.

DROP INDEX IF EXISTS public.idx_invoices_company_invoice_date;

CREATE INDEX CONCURRENTLY idx_invoices_company_invoice_date
  ON public.invoices (company_id, invoice_date DESC, id DESC);
