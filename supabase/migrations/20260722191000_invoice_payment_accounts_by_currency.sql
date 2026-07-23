-- Store invoice payment instructions by settlement currency.

ALTER TABLE public.company_settings
  ADD COLUMN invoice_payment_accounts jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD CONSTRAINT company_settings_invoice_payment_accounts_object
    CHECK (jsonb_typeof(invoice_payment_accounts) = 'object'),
  ADD CONSTRAINT company_settings_invoice_payment_account_currencies
    CHECK (
      invoice_payment_accounts - ARRAY['SEK', 'EUR', 'USD', 'GBP', 'NOK', 'DKK']::text[]
      = '{}'::jsonb
    );

UPDATE public.company_settings
SET invoice_payment_accounts = jsonb_build_object(
  'SEK',
  jsonb_strip_nulls(jsonb_build_object(
    'bank_name', NULLIF(trim(bank_name), ''),
    'clearing_number', NULLIF(trim(clearing_number), ''),
    'account_number', NULLIF(trim(account_number), ''),
    'bankgiro', NULLIF(trim(bankgiro), ''),
    'plusgiro', NULLIF(trim(plusgiro), ''),
    'swish', NULLIF(trim(swish), ''),
    'iban', NULLIF(trim(iban), ''),
    'bic', NULLIF(trim(bic), '')
  ))
)
WHERE COALESCE(
  NULLIF(trim(bank_name), ''),
  NULLIF(trim(clearing_number), ''),
  NULLIF(trim(account_number), ''),
  NULLIF(trim(bankgiro), ''),
  NULLIF(trim(plusgiro), ''),
  NULLIF(trim(swish), ''),
  NULLIF(trim(iban), ''),
  NULLIF(trim(bic), '')
) IS NOT NULL;

COMMENT ON COLUMN public.company_settings.invoice_payment_accounts IS
  'Invoice payment instructions keyed by supported invoice currency. Foreign invoices never fall back to legacy SEK details.';

NOTIFY pgrst, 'reload schema';
