-- English fine print on invoices (crm#1735).
--
-- invoice_late_fee_text (Dröjsmålsränta) and invoice_credit_terms_text
-- (Betalningsvillkor) are one text each, printed on every invoice whatever
-- the customer's language, so an invoice to a customer whose language is
-- English printed the Swedish text under English headings. These columns
-- hold the English text of each. The invoice PDF prints it on an English
-- invoice (customers.language = 'en', the same choice the rest of the PDF
-- and the invoice email make) and falls back to the Swedish column when it
-- is NULL or blank, so a company that never fills them in prints exactly
-- what it printed before.
--
-- Two plain nullable text columns beside the Swedish ones, not a jsonb
-- { sv, en } in their place: the stored Swedish texts stay where they are
-- (no rewrite), and each language is set and cleared on its own, like the
-- Swedish columns. Validated where it is entered (UpdateSettingsSchema).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_late_fee_text_en text,
  ADD COLUMN IF NOT EXISTS invoice_credit_terms_text_en text;

COMMENT ON COLUMN public.company_settings.invoice_late_fee_text_en IS
  'English text of invoice_late_fee_text, printed on invoices to customers whose language is en. NULL or blank prints invoice_late_fee_text.';

COMMENT ON COLUMN public.company_settings.invoice_credit_terms_text_en IS
  'English text of invoice_credit_terms_text, printed on invoices to customers whose language is en. NULL or blank prints invoice_credit_terms_text.';

NOTIFY pgrst, 'reload schema';
