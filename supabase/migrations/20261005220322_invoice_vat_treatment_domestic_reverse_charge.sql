-- Per-invoice VAT treatment: domestic reverse charge for construction
-- services (crm#1007).
--
-- Omvänd betalningsskyldighet (ML 16 kap. 13 §) puts the VAT on the buyer
-- when a construction business buys construction services. The seller
-- invoices without VAT, prints "Omvänd betalningsskyldighet" and the buyer's
-- VAT number (ML 17 kap. 24 §) and reports the sale in ruta 41 (account
-- 3231). It turns on both the buyer and the supply, so the customer record
-- cannot decide it: the invoice states it, next to the treatments
-- 20260927223000 added (#2906).
--
-- This only widens the CHECK on vat_treatment_override with
-- 'reverse_charge_domestic'. The application validates it fail-closed
-- (resolveInvoiceVatRules: a Swedish business customer with a Swedish VAT
-- number, no delivery_country, every line 0 %). No column, trigger, RPC or
-- RLS policy changes; existing rows all satisfy the wider list.
--
-- NOT VALID first, then VALIDATE, as in 20260927223000: the catalog-only add
-- does not scan, and VALIDATE scans under SHARE UPDATE EXCLUSIVE, which does
-- not block reads or writes.

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_vat_treatment_override_check;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_vat_treatment_override_check
  CHECK (vat_treatment_override IS NULL OR vat_treatment_override IN ('standard', 'export', 'reverse_charge', 'reverse_charge_domestic')) NOT VALID;
ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_vat_treatment_override_check;

COMMENT ON COLUMN public.invoices.vat_treatment_override IS
  'VAT treatment the invoice states for its own supply (#2906): standard, export, reverse_charge or reverse_charge_domestic (construction services, ML 16 kap. 13 §, crm#1007). NULL = the customer decides. Validated by resolveInvoiceVatRules.';

NOTIFY pgrst, 'reload schema';
