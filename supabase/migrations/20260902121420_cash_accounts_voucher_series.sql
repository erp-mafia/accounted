-- Verifikationsserie per bankkonto.
--
-- A company that runs several bank accounts (main bank on series A, a
-- company-card account on series M, both imported via CSV) wants entries
-- booked from each account to land in that account's own series. Until now
-- every bank-transaction booking took the single company-wide default from
-- company_settings.default_voucher_series_per_source_type.bank_transaction.
--
-- NULL means "no override": the engine keeps resolving the series from the
-- per-source-type map, so existing accounts and bookings are untouched.
-- Single uppercase letter, same rule as journal_entries.voucher_series.
ALTER TABLE public.cash_accounts
  ADD COLUMN IF NOT EXISTS voucher_series text
  CHECK (voucher_series IS NULL OR voucher_series ~ '^[A-Z]$');

COMMENT ON COLUMN public.cash_accounts.voucher_series IS
  'Optional verifikationsserie (single letter A-Z) for entries booked from this bank account. NULL = follow the per-source-type default in company_settings.';

NOTIFY pgrst, 'reload schema';
