-- Domestic reverse charge for construction services, per customer.
--
-- ML 16 kap. 13 § moves the VAT liability to the buyer when a construction
-- service is sold to a taxable person who supplies construction services
-- other than temporarily. Nothing already stored on a customer proves that:
-- it is a fact about the buyer's business that the seller asserts, so it gets
-- its own column rather than a fifth customer_type.
--
-- Effect on an invoice to a flagged swedish_business customer: lines default
-- to 0%, revenue books to 3231 instead of 3001, no output VAT is booked, and
-- the sale reaches the momsdeklaration in ruta 41 through the existing
-- ACCOUNT_RUTA mapping (lib/reports/vat-declaration.ts). The invoice carries
-- the statutory notation and the buyer's VAT number (ML 17 kap. 24 §).
--
-- Default false: every existing customer keeps ordinary Swedish VAT.
--
-- Application validation: lib/invoices/vat-rules.ts honours the flag for
-- customer_type 'swedish_business' only, so a flag left behind on a customer
-- whose type later changed cannot zero-rate an invoice by accident.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS construction_reverse_charge BOOLEAN NOT NULL DEFAULT false;

-- Defense in depth, same as customers_customer_type_check: the API refuses the
-- combination and the VAT rules ignore it, but two concurrent updates (one
-- setting the flag, one changing the type) could still leave a stale true on a
-- customer the rule cannot apply to. A later switch back to swedish_business
-- would then zero-rate invoices without anyone opting in again.
-- NOT VALID first, then VALIDATE: adding a CHECK in one step holds ACCESS
-- EXCLUSIVE while it scans every row. NOT VALID is catalog-only and still
-- enforces the rule on new and updated rows; VALIDATE then scans under
-- SHARE UPDATE EXCLUSIVE, which does not block reads or writes. Same shape as
-- chart_of_accounts_default_vat_treatment_check (20260815150300).
ALTER TABLE public.customers
  DROP CONSTRAINT IF EXISTS customers_construction_reverse_charge_type_check;
ALTER TABLE public.customers
  ADD CONSTRAINT customers_construction_reverse_charge_type_check
  CHECK (NOT construction_reverse_charge OR customer_type = 'swedish_business') NOT VALID;
ALTER TABLE public.customers
  VALIDATE CONSTRAINT customers_construction_reverse_charge_type_check;

COMMENT ON COLUMN public.customers.construction_reverse_charge IS
  'Buyer accounts for VAT on construction services (ML 16 kap. 13 §). Honoured for customer_type swedish_business only.';

NOTIFY pgrst, 'reload schema';
