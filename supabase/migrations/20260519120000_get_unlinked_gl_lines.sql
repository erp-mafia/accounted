-- Migration: parametrise the unmatched-GL-lines RPC so reconciliation works on
-- any settlement account, not just 1930.
--
-- Why: until now `get_unlinked_1930_lines` hardcoded the bank-side BAS account.
-- EUR/USD customers can't self-reconcile their 1932/1933 accounts and the
-- skattekonto, payment-provider clearing, and BG/PG flows have no path. Now that
-- cash_accounts exists, the RPC accepts an account number parameter and the UI
-- can offer an account selector populated from that table.
--
-- The old function is dropped (no backwards-compatibility shim): the two
-- in-repo callers (lib/reconciliation/bank-reconciliation.ts and
-- app/api/reconciliation/bank/unmatched-entries/route.ts) are updated in the
-- same PR. Anyone calling the RPC over the REST surface must switch to the new
-- name + parameter at the same time.

DROP FUNCTION IF EXISTS public.get_unlinked_1930_lines(uuid, date, date);

CREATE FUNCTION public.get_unlinked_gl_lines(
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
    -- starts at IB and accumulates from there. Keep them excluded from the
    -- unmatched set so reconciliation doesn't surface a phantom voucher.
    AND je.source_type IS DISTINCT FROM 'opening_balance'
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
