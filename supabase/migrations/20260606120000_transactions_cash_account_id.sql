-- Migration: transactions.cash_account_id
--
-- Binds each bank transaction to the specific cash account (cash_accounts row)
-- it settled on. Until now `transactions` only carried `currency` +
-- `bank_connection_id`, so the bank reconciliation (Rapporter → Bankavstämning)
-- filtered transactions by CURRENCY while it filtered GL lines by ACCOUNT
-- NUMBER. A company with two same-currency accounts (e.g. checking 1930 + a
-- savings account on another SEK code) therefore saw every SEK transaction on
-- every account, and the status card summed across both — the reported
-- "shows 1930 even when you switch / sums all transactions" bug (issue #604).
--
-- This is the cash_account_id FK that app/api/transactions/route.ts already
-- referred to as "the cash_account_id backfill tracked as Tier 4".
--
-- Nullable on purpose: legacy rows are backfilled best-effort in the paired
-- 20260606120100_transactions_cash_account_id_backfill.sql migration, and any
-- row that can't be resolved stays NULL. All reconciliation queries treat a
-- NULL cash_account_id as "matches the selected account's currency" so nothing
-- ever disappears from a report mid-backfill.
--
-- ON DELETE SET NULL — never CASCADE: a bank transaction is räkenskaps-
-- information (BFL 7 kap) and must survive the deletion of a cash account.
-- Never RESTRICT: cash accounts are user-disable-able (and occasionally
-- deletable); the FK must not block that. In practice cash accounts are
-- disabled, not hard-deleted, so SET NULL is an edge path that degrades into
-- the same currency fallback as an un-backfilled row.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS cash_account_id UUID
  REFERENCES public.cash_accounts(id) ON DELETE SET NULL;

-- Partial index — in steady state most rows are bound, and the hot
-- reconciliation query is "unmatched rows for account X". The non-NULL slice
-- is exactly what that query needs and keeps the index small during the
-- transition while most rows are still NULL.
CREATE INDEX IF NOT EXISTS idx_transactions_cash_account
  ON public.transactions (company_id, cash_account_id)
  WHERE cash_account_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
