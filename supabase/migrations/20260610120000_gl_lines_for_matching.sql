-- Migration: get_account_gl_lines_for_matching — GL lines on a settlement
-- account as MATCH CANDIDATES, optionally including already-matched ones.
--
-- Why: get_unlinked_gl_lines (20260605130000) returns only lines with NO bank
-- transaction linked. That is correct for the reconciliation status count and
-- the default picker, but it makes a legitimate N:1 case impossible: a single
-- verifikat settled by SEVERAL bank transactions — e.g. a salary run booked as
-- one voucher (1930 credit = total net pay) but paid out as multiple transfers,
-- or a supplier invoice paid in instalments. Once the first transaction links,
-- the voucher vanishes from the candidate list and the user can't attach the
-- rest ("kan inte välja matchade verifikat → kan inte lägga på flera").
--
-- This RPC mirrors get_unlinked_gl_lines exactly (same posted-only filter, same
-- opening_balance / storno / correction exclusions, same date window) and adds:
--   * linked_transaction_count — how many transactions already point at the
--     entry, so the UI can mark a candidate "Redan matchad" and the user opts in
--     consciously.
--   * p_include_matched — when false (default) the result is IDENTICAL to
--     get_unlinked_gl_lines (count = 0 only); when true, already-matched lines
--     are included too.
--
-- The aggregate reconciliation math stays correct under N:1: the GL line is
-- counted ONCE in the period movement regardless of how many transactions point
-- at it, while each transaction sums on the bank side — so linking transactions
-- whose amounts sum to the voucher's bank line nets to zero difference, and any
-- mis-link surfaces immediately as a non-zero difference on the status card.
--
-- A separate function (not a parameter added to get_unlinked_gl_lines) so the
-- status-count path and its existing coverage are untouched, and so the extra
-- column never leaks into callers that don't expect it.

CREATE OR REPLACE FUNCTION public.get_account_gl_lines_for_matching(
  p_company_id      UUID,
  p_account_number  TEXT DEFAULT '1930',
  p_date_from       DATE DEFAULT NULL,
  p_date_to         DATE DEFAULT NULL,
  p_include_matched BOOLEAN DEFAULT false
)
RETURNS TABLE (
  line_id                  UUID,
  journal_entry_id         UUID,
  debit_amount             NUMERIC,
  credit_amount            NUMERIC,
  line_description         TEXT,
  entry_date               DATE,
  voucher_number           INT,
  voucher_series           TEXT,
  entry_description        TEXT,
  source_type              TEXT,
  linked_transaction_count INT
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
    je.source_type,
    (
      SELECT count(*)
      FROM public.transactions t
      WHERE t.journal_entry_id = je.id
        AND t.company_id = p_company_id
    )::int AS linked_transaction_count
  FROM public.journal_entry_lines jel
  JOIN public.journal_entries je ON je.id = jel.journal_entry_id
  WHERE jel.account_number = p_account_number
    AND je.company_id = p_company_id
    AND je.status = 'posted'
    -- Same no-bank-counterpart exclusions as get_unlinked_gl_lines: IB, and the
    -- book-only storno/correction vouchers can never be a bank-transaction target.
    AND je.source_type IS DISTINCT FROM 'opening_balance'
    AND je.source_type IS DISTINCT FROM 'storno'
    AND je.source_type IS DISTINCT FROM 'correction'
    AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
    AND (p_date_to   IS NULL OR je.entry_date <= p_date_to)
    -- Default: only unmatched lines (parity with get_unlinked_gl_lines). When
    -- p_include_matched is true, already-matched lines are returned too so a
    -- second/third transaction can be attached to the same verifikat.
    AND (
      p_include_matched
      OR NOT EXISTS (
        SELECT 1
        FROM public.transactions t
        WHERE t.journal_entry_id = je.id
          AND t.company_id = p_company_id
      )
    )
  ORDER BY je.entry_date, je.voucher_number;
$$;

NOTIFY pgrst, 'reload schema';
