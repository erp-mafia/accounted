-- Repair malformed company VAT numbers (momsregistreringsnummer).
--
-- The onboarding wizard (components/onboarding/Step4VatAccounting.tsx) derived
-- the VAT number as `SE` || org_number || `01`. For an enskild firma the
-- org_number is a 12-digit personnummer (YYYYMMDD-NNNN), so this produced
-- `SE` + 14 digits instead of the canonical `SE` + 10-digit identity + `01`
-- (= SE + 12 digits). Those companies could not save the tax settings page:
-- the pre-filled value is re-submitted on save and rejected by the
-- `^SE\d{12}$` validation in UpdateSettingsSchema.
--
-- Fix: drop the 2 leading junk digits (the personnummer century, or a
-- duplicated org-number prefix) so the value matches SE + 12 digits. The
-- remaining 12 digits already carry the correct 10-digit identity + `01`
-- suffix — verified that every affected row reconciles to the org-number-based
-- canonical value.
--
-- Idempotent and tightly scoped: only rows that are exactly `SE` followed by
-- 14 digits are touched. Already-valid SE+12 rows, NULLs and empty strings are
-- left untouched.
UPDATE public.company_settings
SET vat_number = 'SE' || substr(vat_number, 5)
WHERE vat_number ~ '^SE\d{14}$';
