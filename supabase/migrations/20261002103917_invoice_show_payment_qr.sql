-- Bank-app payment QR on invoices (crm#249).
--
-- A QR code in the UsingQR format (https://qrkod.info/) that Swedish bank
-- apps scan to fill in a bankgiro or plusgiro payment: payee, account,
-- OCR or invoice number, due date and the amount to pay. The invoice PDF
-- prints it in the payment box of a SEK invoice while this switch is on.
--
-- DEFAULT false: no existing company's invoices change until someone turns
-- it on in the invoice print settings.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_show_payment_qr boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.invoice_show_payment_qr IS
  'Print the bank-app payment QR (UsingQR format) in the payment box of SEK invoices paid to a bankgiro or plusgiro.';

NOTIFY pgrst, 'reload schema';
