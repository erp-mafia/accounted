-- Migration: transactions.is_ignored
--
-- Adds an "ignore" flag for bank transactions the user has chosen to suppress
-- from the bank reconciliation view (Rapporter → Bankavstämning) without
-- booking them. Use case: small ränteintäkter, opening-balance adjustments,
-- rounding noise — the user wants the row off the unmatched list but doesn't
-- want to fabricate a verifikation.
--
-- The flag is intentionally orthogonal to `is_business`:
--   - is_business=null  → not yet triaged
--   - is_business=true  → bokförd som affärstransaktion (has journal_entry_id)
--   - is_business=false → privat uttag (has journal_entry_id, 2013 in EF)
--   - is_ignored=true   → "hide from reconciliation, never going to book it"
--
-- An ignored transaction MUST NOT have a journal_entry_id. The check
-- enforces that — once booked, the row has a verifikation and "ignored" is
-- meaningless. Unignoring is just `is_ignored=false`; safe because we never
-- created an entry to reverse.

ALTER TABLE public.transactions
  ADD COLUMN IF NOT EXISTS is_ignored BOOLEAN NOT NULL DEFAULT false;

-- An ignored transaction has no journal entry. Without this constraint a
-- categorize → ignore race could leave the row both booked AND hidden from
-- the reconciliation list, which is exactly the silent-divergence pattern
-- bank reconciliation exists to prevent.
ALTER TABLE public.transactions
  ADD CONSTRAINT transactions_is_ignored_no_journal_entry
  CHECK (is_ignored = false OR journal_entry_id IS NULL);

-- Partial index — most rows will be is_ignored=false, only the small slice
-- of intentionally-skipped transactions need to be looked up by this flag.
CREATE INDEX IF NOT EXISTS idx_transactions_is_ignored
  ON public.transactions (company_id, is_ignored)
  WHERE is_ignored = true;

NOTIFY pgrst, 'reload schema';
