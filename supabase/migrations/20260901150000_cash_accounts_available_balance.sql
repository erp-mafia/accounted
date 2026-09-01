-- Bank-reported AVAILABLE balance alongside the booked balance (issue: PSD2
-- flow delivers transactions but no usable saldo; the Enable Banking BALANCES
-- response carries both types and the available one was discarded).
-- Nullable and additive: rows without a PSD2 connection, or synced before this
-- shipped, simply have no value yet.
ALTER TABLE public.cash_accounts
  ADD COLUMN IF NOT EXISTS available_balance NUMERIC;

COMMENT ON COLUMN public.cash_accounts.available_balance IS
  'Bank-reported available balance (PSD2 interimAvailable/closingAvailable), as of balance_updated_at. NULL when the bank returns no available type or the account is not PSD2-sourced.';

NOTIFY pgrst, 'reload schema';
