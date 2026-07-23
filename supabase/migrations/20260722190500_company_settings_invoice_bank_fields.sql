-- Add the legacy SEK bank fields required by currency-specific invoice accounts.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS bank_name text,
  ADD COLUMN IF NOT EXISTS clearing_number text,
  ADD COLUMN IF NOT EXISTS account_number text;

COMMENT ON COLUMN public.company_settings.bank_name IS
  'Legacy SEK invoice bank name mirrored from invoice_payment_accounts.SEK.';
COMMENT ON COLUMN public.company_settings.clearing_number IS
  'Legacy SEK invoice clearing number mirrored from invoice_payment_accounts.SEK.';
COMMENT ON COLUMN public.company_settings.account_number IS
  'Legacy SEK invoice account number mirrored from invoice_payment_accounts.SEK.';

NOTIFY pgrst, 'reload schema';
