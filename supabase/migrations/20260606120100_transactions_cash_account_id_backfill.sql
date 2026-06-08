-- Migration: backfill transactions.cash_account_id
--
-- Best-effort population of the cash_account_id added in
-- 20260606120000_transactions_cash_account_id.sql. Four passes, in descending
-- order of authority. Every pass touches ONLY rows that are still NULL, so the
-- migration is idempotent and safe to re-run / resume after an interruption.
--
-- Rows that no pass resolves stay NULL — reconciliation queries fall back to
-- currency matching for those, exactly as before this feature, so nothing
-- disappears from any report.

-- Pass (a) — Booked rows via the voucher's bank line. Most authoritative:
-- reflects where the money was actually booked. Map the journal entry's single
-- 19xx line to a cash account by (company_id, ledger_account).
--
-- Vouchers with MORE than one bank-class (19xx) line are own-account transfers
-- (e.g. 1930 → 1931) and are ambiguous — which leg is "this transaction"? We
-- deliberately skip them (leave NULL) rather than guess wrong.
UPDATE public.transactions t
SET cash_account_id = ca.id
FROM public.journal_entry_lines jel
JOIN public.cash_accounts ca
  ON ca.ledger_account = jel.account_number
WHERE t.cash_account_id IS NULL
  AND t.journal_entry_id IS NOT NULL
  AND jel.journal_entry_id = t.journal_entry_id
  -- Relate the cash account to the target by company in WHERE, not in the JOIN
  -- ON above: Postgres forbids referencing the UPDATE target (t) from a
  -- FROM-clause join condition ("invalid reference to FROM-clause entry for t").
  AND ca.company_id = t.company_id
  AND jel.account_number BETWEEN '1900' AND '1999'
  AND (
    SELECT count(*)
    FROM public.journal_entry_lines x
    WHERE x.journal_entry_id = t.journal_entry_id
      AND x.account_number BETWEEN '1900' AND '1999'
  ) = 1;

-- Pass (b) — PSD2 rows via the owned-account identity embedded in external_id.
-- Enable Banking writes external_id = 'eb_<iban|uid>_<txid>'
-- (extensions/general/enable-banking/lib/sync.ts). Match the prefix against the
-- cash account's iban or external_uid. The trailing '_' in the prefix makes
-- this an exact account match (prevents 'SE111' matching 'SE1112…'), and
-- starts_with avoids LIKE wildcard/metacharacter ambiguity entirely.
UPDATE public.transactions t
SET cash_account_id = ca.id
FROM public.cash_accounts ca
WHERE t.cash_account_id IS NULL
  AND ca.company_id = t.company_id
  AND t.external_id IS NOT NULL
  AND (
    (ca.iban IS NOT NULL
       AND starts_with(t.external_id, 'eb_' || ca.iban || '_'))
    OR
    (ca.external_uid IS NOT NULL
       AND starts_with(t.external_id, 'eb_' || ca.external_uid || '_'))
  );

-- Pass (c) — Single-account-of-currency fallback. If a company has exactly one
-- ENABLED cash account in the row's currency, the row unambiguously belongs to
-- it. Resolves the single-account majority (incl. CSV imports, which carry no
-- account identity). Deliberately does NOT fire for the 2-same-currency case
-- (HAVING count(*) = 1) — those rows stay NULL and rely on passes (a)/(b) or
-- on the currency fallback at query time. We must not guess between checking
-- and savings.
WITH single_ca AS (
  -- (array_agg(id))[1], not min(id): Postgres has no min() aggregate for uuid.
  -- HAVING count(*) = 1 guarantees exactly one row per group, so the array has
  -- a single element and which one we pick is moot.
  SELECT company_id, currency, (array_agg(id))[1] AS cash_account_id
  FROM public.cash_accounts
  WHERE enabled = true
  GROUP BY company_id, currency
  HAVING count(*) = 1
)
UPDATE public.transactions t
SET cash_account_id = s.cash_account_id
FROM single_ca s
WHERE t.cash_account_id IS NULL
  AND s.company_id = t.company_id
  AND s.currency = t.currency;

-- Pass (d) — anything still NULL is left as-is (query-time currency fallback).

NOTIFY pgrst, 'reload schema';
