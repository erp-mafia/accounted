-- Partial unique index on journal_entries to prevent duplicate voucher numbers.
-- Drafts use voucher_number = 0 (integer NOT NULL), so WHERE > 0 excludes them.
-- This enforces BFL 5:7 at the database level — application logic alone is insufficient.
CREATE UNIQUE INDEX IF NOT EXISTS uq_journal_entries_voucher_number
  ON public.journal_entries (company_id, fiscal_period_id, voucher_series, voucher_number)
  WHERE voucher_number > 0;
