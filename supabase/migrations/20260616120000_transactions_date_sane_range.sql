-- Backstop against malformed transaction dates.
--
-- The manual "add transaction" form historically inserted straight into
-- `transactions` via the browser Supabase client (no server route, no
-- server-side validation). A native <input type="date"> whose year subfield is
-- over-typed can emit a 6-digit year (e.g. '202403-02-05' = year 202403);
-- Postgres' `date` type accepts it, the row saves, and every date-fns formatter
-- then throws RangeError on render — taking down the whole dashboard route via
-- the error boundary. (Real incident, 2026-06: company 4e4e41e7 locked out of
-- the transactions page.)
--
-- This CHECK is the database-level guard: an out-of-range date is rejected at
-- INSERT/UPDATE instead of silently corrupting a row. The window is wide on
-- purpose — it only rejects garbage, never a legitimate accounting date.
-- CHECK expressions must be immutable, so we cannot bound against CURRENT_DATE.
--
-- Idempotent: safe to re-run / replay on preview branches.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'transactions_date_sane_range'
      AND conrelid = 'public.transactions'::regclass
  ) THEN
    ALTER TABLE public.transactions
      ADD CONSTRAINT transactions_date_sane_range
      CHECK (date >= DATE '1900-01-01' AND date <= DATE '2100-12-31');
  END IF;
END $$;

NOTIFY pgrst, 'reload schema';
