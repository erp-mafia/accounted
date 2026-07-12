-- Per-company editable invoice email texts (subject, greeting, body, sign-off)
-- in sv + en. NULL column / missing keys / whitespace-only values fall back to
-- the hardcoded defaults in lib/email/invoice-templates.ts. Overrides apply
-- ONLY to standard invoices (document_type = 'invoice' or absent, and not a
-- credit note) — enforced in the template lib, not here.
-- Length limits are enforced by UpdateSettingsSchema (the only write path);
-- mirrors the invoice_late_fee_text / invoice_credit_terms_text precedent.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_email_texts JSONB NULL;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_invoice_email_texts_object;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_invoice_email_texts_object
  CHECK (invoice_email_texts IS NULL OR jsonb_typeof(invoice_email_texts) = 'object');

COMMENT ON COLUMN public.company_settings.invoice_email_texts IS
  'Overrides for the standard-invoice email: { sv?: { subject?, greeting?, body?, signoff? }, en?: {...} }. Placeholders {fakturanummer} {kundnamn} {förnamn} {företag} {förfallodatum} {belopp} are substituted at send time by lib/email/invoice-templates.ts. NULL / missing / whitespace-only fields fall back to the hardcoded defaults. Ignored for credit notes, proforma and delivery notes.';

NOTIFY pgrst, 'reload schema';
