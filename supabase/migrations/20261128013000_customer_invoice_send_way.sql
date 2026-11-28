-- Skickas som on the customer card.
-- pg-test: tests/pg/customer-invoice-send-way.pg.test.ts
--
-- customers.invoice_send_way: the way this customer's invoices go out first,
-- one of the ways of company_settings.invoice_send_order (peppol, kivra,
-- billo, email). The invoice editor tries it before the company's order and
-- passes it over when the invoice cannot use it (no Peppol id for the buyer,
-- no email address), so the company's order then decides as it does without
-- one (lib/invoices/send-order.ts sendOrderForCustomer). NULL follows the
-- company's order.
--
-- NULL for every existing customer and nothing is backfilled: no customer's
-- invoices change until someone sets the field.
--
-- A column on an existing table: the table's RLS policies and grants cover it.
--
-- customers is read on every invoice page: fail the migration job instead of
-- queueing those reads behind it. The column is nullable with no default
-- (catalogue only) and the CHECK is added NOT VALID, so nothing here reads
-- the table; 20261128013100 validates it under the weaker lock.

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS invoice_send_way text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'customers_invoice_send_way_check'
      AND conrelid = 'public.customers'::regclass
  ) THEN
    ALTER TABLE public.customers
      ADD CONSTRAINT customers_invoice_send_way_check
      CHECK (invoice_send_way IN ('peppol', 'kivra', 'billo', 'email'))
      NOT VALID;
  END IF;
END
$$;

COMMENT ON COLUMN public.customers.invoice_send_way IS
  'Skickas som: the way this customer''s invoices go out first (peppol, kivra, billo, email), tried before company_settings.invoice_send_order and passed over when the invoice cannot use it. Null = the company''s order.';

NOTIFY pgrst, 'reload schema';
