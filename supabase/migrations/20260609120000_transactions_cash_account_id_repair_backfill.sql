-- Migration: repair transactions.cash_account_id
--
-- Why this exists: the original best-effort backfill
-- (20260606120100_transactions_cash_account_id_backfill.sql) only ever touched
-- rows whose cash_account_id was still NULL, and an earlier revision of its
-- single-account pass mis-assigned rows (the "min(uuid)" bug fixed in a later
-- commit). Migrations run exactly once, so any instance that applied the buggy
-- revision now carries WRONG (non-NULL) cash_account_id values that the
-- NULL-only backfill can never correct.
--
-- The visible symptom: Bankavstämning (Reports → Bank reconciliation) showed
-- "Banktransaktioner i perioden: 0 kr" while the 1930 GL movement and a large
-- difference were still displayed — because the per-account scoping filtered
-- every transaction out (its cash_account_id matched neither the resolved 1930
-- account nor the NULL fallback), while the GL side (scoped only by account
-- number) was unaffected.
--
-- This migration RE-DERIVES cash_account_id where it can do so deterministically,
-- correcting mis-assignments rather than only filling NULLs. It is idempotent:
-- every pass is a no-op once the data is already correct.

-- ------------------------------------------------------------
-- 0. Re-seed the default 1930 SEK cash account for any company missing one.
--    Mirrors 20260519154732_seed_default_cash_account.sql so a company created
--    through a path that skipped the seed (or before it existed) still has a
--    routable account to scope against. Idempotent via the unique constraint.
-- ------------------------------------------------------------
INSERT INTO public.cash_accounts (
  company_id, ledger_account, currency, name, enabled, is_primary, source
)
SELECT
  c.id,
  '1930',
  'SEK',
  'Företagskonto (SEK)',
  true,
  NOT EXISTS (
    SELECT 1 FROM public.cash_accounts ca2
    WHERE ca2.company_id = c.id AND ca2.is_primary = true
  ),
  'manual'
FROM public.companies c
WHERE NOT EXISTS (
  SELECT 1 FROM public.cash_accounts ca
  WHERE ca.company_id = c.id AND ca.ledger_account = '1930'
)
ON CONFLICT (company_id, ledger_account) DO NOTHING;

-- ------------------------------------------------------------
-- 1. Authoritative repair for BOOKED rows — from the voucher's single bank line.
--    Unlike the original pass (a) this does NOT require cash_account_id IS NULL,
--    so it CORRECTS a row that was mis-assigned. The voucher's 19xx line is the
--    ground truth for where a booked transaction settled.
--
--    Own-account transfers (>1 bank-class line, e.g. 1930 → 1931) are ambiguous
--    and left untouched, exactly as the original backfill skipped them.
-- ------------------------------------------------------------
UPDATE public.transactions t
SET cash_account_id = ca.id
FROM public.journal_entry_lines jel
JOIN public.cash_accounts ca
  ON ca.ledger_account = jel.account_number
WHERE t.journal_entry_id IS NOT NULL
  AND jel.journal_entry_id = t.journal_entry_id
  AND ca.company_id = t.company_id
  AND jel.account_number BETWEEN '1900' AND '1999'
  AND t.cash_account_id IS DISTINCT FROM ca.id
  AND (
    SELECT count(*)
    FROM public.journal_entry_lines x
    WHERE x.journal_entry_id = t.journal_entry_id
      AND x.account_number BETWEEN '1900' AND '1999'
  ) = 1;

-- ------------------------------------------------------------
-- 2. Deterministic repair for SINGLE-account-of-currency companies.
--    When a company has exactly one ENABLED cash account in a given currency,
--    every transaction of that currency unambiguously belongs to it — whether
--    the row is currently NULL or was mis-assigned. This fixes the entire
--    single-bank-account majority (the common enskild firma / aktiebolag with
--    one 1930 SEK account) in one shot.
--
--    Companies with two same-currency accounts (e.g. checking + savings) are
--    excluded (HAVING count(*) = 1): we must not guess between them. Their
--    booked rows are already corrected by pass 1; their unbooked rows keep
--    whatever they had and rely on the query-time currency fallback.
-- ------------------------------------------------------------
WITH single_ca AS (
  SELECT company_id, currency, (array_agg(id))[1] AS cash_account_id
  FROM public.cash_accounts
  WHERE enabled = true
  GROUP BY company_id, currency
  HAVING count(*) = 1
)
UPDATE public.transactions t
SET cash_account_id = s.cash_account_id
FROM single_ca s
WHERE s.company_id = t.company_id
  AND s.currency = t.currency
  AND t.cash_account_id IS DISTINCT FROM s.cash_account_id;

-- Pass 3 — anything still NULL (multi-same-currency-account companies' unbooked
-- rows) is left as-is; the query-time currency fallback in
-- scopeTransactionsToAccount() covers it.

NOTIFY pgrst, 'reload schema';
