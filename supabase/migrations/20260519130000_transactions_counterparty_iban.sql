-- Migration: capture counterparty IBAN on transactions for transfer-pairing.
--
-- Why: PSD2 returns the creditor (outflow) or debtor (inflow) account IBAN on
-- every booked transaction, but gnubok hasn't persisted it. Without an IBAN
-- column, intra-account transfers ("move money from SEK 1930 to EUR 1932")
-- can't be auto-detected and end up double-categorized.
--
-- The new column is nullable: SIE imports, manual entries, and pre-existing
-- rows have no IBAN. counterparty_account stays as a fallback for Bankgiro /
-- Plusgiro identifiers when IBAN is absent (Swedish domestic transfers).
--
-- The partial index supports the own-account detector's primary lookup:
--   SELECT ... FROM transactions WHERE company_id = ? AND counterparty_iban = ?

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS counterparty_iban TEXT,
  ADD COLUMN IF NOT EXISTS counterparty_account TEXT;

CREATE INDEX IF NOT EXISTS idx_transactions_counterparty_iban
  ON public.transactions (company_id, counterparty_iban)
  WHERE counterparty_iban IS NOT NULL;

NOTIFY pgrst, 'reload schema';
