-- A customer can issue a given number only once per company. Regular invoices
-- keep their own numbering. Ignore surrounding spaces on existing references.
-- Resolve existing duplicates explicitly before applying: this migration
-- does not alter any invoice or voucher. A failed concurrent build can leave
-- an invalid index behind, so clear it before retrying the migration.
-- pg-test: covered-by tests/pg/self-billing-invoice.pg.test.ts
DROP INDEX IF EXISTS public.idx_invoices_self_billed_number;

CREATE UNIQUE INDEX CONCURRENTLY idx_invoices_self_billed_number
  ON public.invoices (company_id, customer_id, (btrim(external_invoice_number)))
  WHERE is_self_billed;
