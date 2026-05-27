-- Add customer_type to customers.
--
-- Distinguishes individual customers (private persons, ROT/RUT eligible),
-- Swedish businesses, EU businesses (VIES VAT validation eligible), and
-- non-EU businesses. Drives VAT treatment selection on invoices and which
-- identifier (personnummer vs org_number) the UI surfaces.
--
-- Note: this column was previously created directly in production without
-- a migration. This migration backfills the missing definition so that
-- staging, preview branches, and CI databases match prod. Existing prod
-- rows already carry valid values (individual/swedish_business/eu_business/
-- non_eu_business) so the CHECK constraint passes against current data.
--
-- Application validation: lib/api/schemas.ts CustomerTypeSchema enforces
-- the enum at the API boundary; the DB constraint is defense-in-depth.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS customer_type TEXT NOT NULL DEFAULT 'individual';

ALTER TABLE public.customers DROP CONSTRAINT IF EXISTS customers_customer_type_check;
ALTER TABLE public.customers ADD CONSTRAINT customers_customer_type_check
  CHECK (customer_type IN ('individual', 'swedish_business', 'eu_business', 'non_eu_business'));

NOTIFY pgrst, 'reload schema';
