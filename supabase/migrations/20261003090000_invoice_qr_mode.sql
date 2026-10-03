-- One QR code per invoice, chosen automatically.
--
-- The invoice PDF used to stack up to three payment QR codes (Swish, the
-- payment link and the bank-app UsingQR code), each behind its own switch.
-- It now prints at most one, decided by a mode:
--
--   auto          Swish for a private customer when Swish is usable, else the
--                 bank-app QR when it is usable, else Swish, else the
--                 payment-link QR when the invoice has a link, else none.
--   bank_app      the bank-app QR (UsingQR), or none when it is unusable
--   swish         the Swish QR, or none when it is unusable
--   payment_link  the payment-link QR, or none when the invoice has no link
--   none          no QR code
--
-- An explicit mode never falls back to another code: the invoice prints none
-- and the editor says why (lib/invoices/payment-qr.ts).
--
-- company_settings.invoice_qr_mode is the company default. invoices.qr_mode
-- overrides it for one invoice; NULL inherits the company default.
--
-- ADD COLUMN with a constant DEFAULT fills every existing row without an
-- UPDATE (an UPDATE on company_settings would trip
-- block_migration_reset_source_mutation on reset-source rows).

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS invoice_qr_mode text NOT NULL DEFAULT 'auto'
    CONSTRAINT company_settings_invoice_qr_mode_check
    CHECK (invoice_qr_mode IN ('auto', 'bank_app', 'swish', 'payment_link', 'none'));

COMMENT ON COLUMN public.company_settings.invoice_qr_mode IS
  'The one payment QR code invoice PDFs print: auto (Swish to private customers when usable, else bank app, else Swish, else the payment link), bank_app, swish, payment_link or none. invoices.qr_mode overrides it per invoice.';

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS qr_mode text NULL
    CONSTRAINT invoices_qr_mode_check
    CHECK (qr_mode IN ('auto', 'bank_app', 'swish', 'payment_link', 'none'));

COMMENT ON COLUMN public.invoices.qr_mode IS
  'Per-invoice override of company_settings.invoice_qr_mode (auto, bank_app, swish, payment_link, none). NULL inherits the company default.';

-- The old bank-app switch stays for API compatibility but no longer decides
-- what the PDF prints.
COMMENT ON COLUMN public.company_settings.invoice_show_payment_qr IS
  'Superseded by invoice_qr_mode (migration 20261003090000): still accepted by the settings APIs, no longer read when rendering an invoice.';

NOTIFY pgrst, 'reload schema';
