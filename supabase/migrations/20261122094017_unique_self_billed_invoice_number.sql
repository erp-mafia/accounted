-- A customer can issue a given number only once per company. Regular invoices
-- keep their own numbering. Ignore surrounding spaces on existing references.
-- Resolve existing duplicates explicitly before applying: this migration
-- does not alter any invoice or voucher.
-- pg-test: covered-by tests/pg/self-billing-invoice.pg.test.ts
SELECT set_config('lock_timeout', '5s', true);

CREATE UNIQUE INDEX idx_invoices_self_billed_number
  ON public.invoices (company_id, customer_id, (btrim(external_invoice_number)))
  WHERE is_self_billed;
