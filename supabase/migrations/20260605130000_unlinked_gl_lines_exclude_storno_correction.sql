-- Migration: exclude storno/correction vouchers from the unmatched-GL-lines set.
--
-- Why: a correction made via the storno flow (correctEntry in
-- lib/core/bookkeeping/storno-service.ts, reverseEntry in lib/bookkeeping/engine.ts)
-- produces a posted 'storno' voucher (the reversal, debit/credit swapped) and, for
-- correctEntry, a posted 'correction' voucher (the re-booking). Neither is an
-- independent bank movement — they are pure book corrections of an existing
-- posting. Exactly like 'opening_balance' (excluded since
-- 20260514132534_unlinked_1930_lines_exclude_opening_balance.sql) they have no
-- counterpart in the bank feed and can NEVER be matched to a bank transaction
-- (the reconciliation link is one-directional: a transaction points at an entry,
-- and storno/correction entries are never the target). Left in the set they sit
-- in "Omatchade verifikationer" indefinitely and make a fully-reconciled period
-- look unbalanced — the exact symptom users report when a rättelse/storno shows
-- up as an omatchad verifikation.
--
-- The reversed ORIGINAL is already excluded here: this RPC only returns
-- status='posted' lines, and a reversed entry is status='reversed'.
--
-- Precedent: compute_prior_opening_balances
-- (20260421180000_opening_balances_rpc_fix_reversed_and_new_accounts.sql) already
-- excludes source_type='storno' from its balance roll-up for the same BFL 5:5
-- reason — a cancelled posting must not contribute to a computed figure.
--
-- IS DISTINCT FROM (not NOT IN) is used so a NULL source_type line — a legitimate
-- bank line — is kept, matching the existing opening_balance guard.

CREATE OR REPLACE FUNCTION public.get_unlinked_gl_lines(
  p_company_id      UUID,
  p_account_number  TEXT DEFAULT '1930',
  p_date_from       DATE DEFAULT NULL,
  p_date_to         DATE DEFAULT NULL
)
RETURNS TABLE (
  line_id            UUID,
  journal_entry_id   UUID,
  debit_amount       NUMERIC,
  credit_amount      NUMERIC,
  line_description   TEXT,
  entry_date         DATE,
  voucher_number     INT,
  voucher_series     TEXT,
  entry_description  TEXT,
  source_type        TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT
    jel.id AS line_id,
    je.id AS journal_entry_id,
    jel.debit_amount,
    jel.credit_amount,
    jel.line_description,
    je.entry_date,
    je.voucher_number,
    je.voucher_series,
    je.description AS entry_description,
    je.source_type
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_number = p_account_number
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    -- IB lines never have a counterpart in the bank feed — the bank statement
    -- starts at IB and accumulates from there. Keep them excluded so
    -- reconciliation doesn't surface a phantom voucher.
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    -- Storno/correction are book-only corrections of an existing posting; they
    -- have no independent bank movement and can never be matched. Exclude them
    -- so a corrected/reversed period doesn't look unbalanced.
    AND je.source_type IS DISTINCT FROM 'storno'
    AND je.source_type IS DISTINCT FROM 'correction'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    AND NOT EXISTS (
      SELECT 1
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

NOTIFY pgrst, 'reload schema';
