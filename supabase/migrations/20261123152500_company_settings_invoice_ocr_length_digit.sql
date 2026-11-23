-- Whether the OCR reference on the company's customer invoices carries
-- Bankgirot's length digit before the check digit (invoice 1042 is paid as
-- 104265, not 10421). A bankgiro whose OCR control at the bank also checks
-- the reference's length refuses a reference without it, so the company
-- chooses the form its agreement asks for. Default false: the reference
-- stays the invoice number and its check digit.
--
-- Read by lib/invoices/ocr-reference.ts (invoiceOcrReference). The bank match
-- reads an incoming payment under either form (lib/invoices/ocr-keys.ts).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_ocr_length_digit boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
