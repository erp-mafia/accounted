-- Per-invoice VAT treatment (#2906).
--
-- An invoice's VAT treatment was derived from the customer record alone
-- (lib/invoices/vat-rules.ts getVatRules). That is the right default for a
-- service, which is taxed where the buyer is established, and the wrong one
-- for goods, whose export and intra-EU exemptions (ML 10 kap.) turn on where
-- the goods are transported: a Swedish company buying goods shipped to Norway
-- is an export (ruta 36), not a 25 % sale. These two columns record what the
-- invoice itself states about its supply:
--
--   vat_treatment_override  'standard' (Swedish VAT at the line rates),
--                           'export' or 'reverse_charge'; NULL = the customer
--                           decides.
--   delivery_country        ISO 3166-1 alpha-2 country the GOODS are
--                           transported to; NULL = not a goods delivery
--                           abroad (services, or unstated).
--
-- The application validates them fail-closed (resolveInvoiceVatRules): an
-- export needs a destination outside the EU, an intra-EU supply a destination
-- in another member state and the buyer's VIES-validated VAT number from a
-- member state other than Sweden. They are stored, not just applied, so a
-- draft edit and a customer change (sync-draft-vat-headers) re-decide the
-- header from the same statement, and so booking can tell goods from
-- services: under an export / reverse_charge header a set delivery_country
-- books revenue on 3105 / 3108 (rutor 36 / 35) instead of 3305 / 3308
-- (rutor 40 / 39). Credit notes and quote conversions copy both.
--
-- Both nullable with no default: every existing invoice keeps NULL and books
-- exactly as before. No trigger, RPC or RLS policy changes.
--
-- NOT VALID first, then VALIDATE: adding a CHECK in one step holds ACCESS
-- EXCLUSIVE while it scans every row. NOT VALID is catalog-only and still
-- enforces the rule on new and updated rows; VALIDATE then scans under
-- SHARE UPDATE EXCLUSIVE, which does not block reads or writes. Same shape as
-- chart_of_accounts_default_vat_treatment_check (20260815150300).

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS vat_treatment_override text,
  ADD COLUMN IF NOT EXISTS delivery_country text;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_vat_treatment_override_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_vat_treatment_override_check
  CHECK (vat_treatment_override IS NULL OR vat_treatment_override IN ('standard', 'export', 'reverse_charge')) NOT VALID;
ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_vat_treatment_override_check;

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_delivery_country_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_delivery_country_check
  CHECK (delivery_country IS NULL OR delivery_country ~ '^[A-Z]{2}$') NOT VALID;
ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_delivery_country_check;

COMMENT ON COLUMN public.invoices.vat_treatment_override IS
  'VAT treatment the invoice states for its own supply (#2906): standard, export or reverse_charge. NULL = the customer decides. Validated by resolveInvoiceVatRules.';
COMMENT ON COLUMN public.invoices.delivery_country IS
  'ISO 3166-1 alpha-2 country the goods are transported to (#2906). Under an export / reverse_charge header it books the goods accounts 3105 / 3108 instead of 3305 / 3308.';

NOTIFY pgrst, 'reload schema';
