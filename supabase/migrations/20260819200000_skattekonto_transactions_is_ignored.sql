-- Migration: skattekonto_transactions.is_ignored
--
-- Skattekonto rows are an external mirror of Skatteverket's ledger: they must
-- never be deleted (same policy as imported bank transactions, see
-- lib/transactions/origin.ts), but until now they also had no way OUT of the
-- work list. A row that predates the company's first fiscal year (typical for
-- an enskild firma, whose personal skattekonto history predates the company)
-- can never be booked: findFiscalPeriod refuses (PERIOD_LOCKED), no route
-- deletes, and the row was visible forever.
--
-- This copies the transactions.is_ignored precedent (20260529190000):
--   is_ignored = true -> "hide from the skattekonto work list, never going to
--   book it". Fully reversible (is_ignored = false); no journal entry was
--   ever created, so there is nothing to reverse.
--
-- RLS: the existing company-scoped UPDATE policy on skattekonto_transactions
-- already covers this column (USING/WITH CHECK on company membership), so no
-- policy change is needed.

ALTER TABLE public.skattekonto_transactions
  ADD COLUMN IF NOT EXISTS is_ignored BOOLEAN NOT NULL DEFAULT false;

-- An ignored row has no journal entry. Without this constraint a
-- book -> ignore race could leave the row both booked AND hidden from the
-- list, silently diverging the 1630 ledger from Skatteverket's mirror.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'skattekonto_transactions_is_ignored_no_journal_entry'
      AND conrelid = 'public.skattekonto_transactions'::regclass
  ) THEN
    ALTER TABLE public.skattekonto_transactions
      ADD CONSTRAINT skattekonto_transactions_is_ignored_no_journal_entry
      CHECK (is_ignored = false OR journal_entry_id IS NULL);
  END IF;
END $$;

-- Partial index: most rows are is_ignored=false; only the small ignored
-- slice is looked up by this flag (the "N ignorerade" count line).
CREATE INDEX IF NOT EXISTS idx_skattekonto_transactions_is_ignored
  ON public.skattekonto_transactions (company_id, is_ignored)
  WHERE is_ignored = true;

NOTIFY pgrst, 'reload schema';
