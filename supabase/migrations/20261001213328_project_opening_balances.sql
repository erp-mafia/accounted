-- Project opening balances end to end (issue #3313).
--
-- A project's opening balance lives on the IB verifikat's own lines: the
-- year-end close and the SIE import now split each balance-sheet account's IB
-- into one line per object of an accumulating dimension (bag {"6": "<code>"},
-- registry flag dimensions.resets_annually = false) plus one untagged
-- remainder line. Account totals never change. This migration gives the
-- readers what they need to see those lines:
--
-- 1. prior_opening_balance_lines(company, period_start): the effective prior
--    lines, with their bags, that compute_prior_opening_balances has always
--    summed. One definition of the "earliest IB entry, unless non-IB activity
--    predates it" rule for every caller below.
--
--    Correction folded in: the earliest IB was picked with ROW_NUMBER over
--    (entry_date, created_at, id) per account, so when that entry holds
--    several lines on one account (a split IB, or two source accounts mapped
--    onto one target in an SIE import) only ONE arbitrary line was kept.
--    DENSE_RANK keeps every line of the earliest entry. Identical for the
--    one-line-per-account IB entries that were the norm until now.
--
-- 2. compute_prior_opening_balances(company, period_start, p_dimensions):
--    the continuation-import fallback for IB, now dimension-scoped with the
--    same jsonb containment the period lines use. Adding a parameter under
--    CREATE OR REPLACE would create a second overload, so the (uuid, date)
--    signature is dropped and recreated with p_dimensions DEFAULT NULL: every
--    two-argument caller (getOpeningBalances, the KPI report, the byrå KPI
--    overview) resolves to it unchanged. Which lines count as effective is
--    decided before the filter, per account, so the per-object amounts always
--    add up to the unfiltered account total.
--
-- 3. compute_object_closing_balances(company, fiscal_period, dim_nos): a
--    closed year's closing balance per (balance-sheet account, bag projected
--    onto dim_nos), read exactly the way the trial balance reads it (the
--    linked IB entry's lines or the fallback above, plus the period's posted
--    and reversed entries except the IB entry). generateOpeningBalances
--    splits next year's IB on it. One jsonb array: no PostgREST row cap.
--
-- Diff against main before merge: another PR redefining
-- compute_prior_opening_balances would silently overwrite this one.

-- 1 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.prior_opening_balance_lines(
  p_company_id uuid,
  p_period_start date
)
RETURNS TABLE (account_number text, debit_amount numeric, credit_amount numeric, dimensions jsonb)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH ib_lines_ranked AS (
    -- Currently-effective IB lines only. Reversed originals and their stornos
    -- are both excluded (originals by status, stornos by source_type below).
    -- DENSE_RANK: every line of the earliest IB entry for the account.
    SELECT
      jel.account_number,
      jel.debit_amount,
      jel.credit_amount,
      jel.dimensions,
      je.entry_date,
      DENSE_RANK() OVER (
        PARTITION BY jel.account_number
        ORDER BY je.entry_date ASC, je.created_at ASC, je.id ASC
      ) AS rnk
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.entry_date < p_period_start
      AND je.source_type = 'opening_balance'
      AND substr(jel.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  earliest_ib AS (
    SELECT r.account_number, r.debit_amount, r.credit_amount, r.dimensions, r.entry_date
    FROM ib_lines_ranked r
    WHERE r.rnk = 1
  ),
  non_ib_lines AS (
    -- Non-IB, non-storno posted lines. Excluding source_type = 'storno'
    -- pairs with the status = 'posted' filter on reversed originals so a
    -- cancelled entry contributes zero on both sides.
    SELECT
      jel.account_number,
      jel.debit_amount,
      jel.credit_amount,
      jel.dimensions,
      je.entry_date
    FROM public.journal_entry_lines jel
    JOIN public.journal_entries je ON je.id = jel.journal_entry_id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND je.entry_date < p_period_start
      AND je.source_type NOT IN ('opening_balance', 'storno')
      AND substr(jel.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  effective_ib AS (
    -- Keep the earliest IB for an account only if no non-IB activity
    -- predates it. A later-year IB for an account with prior-year
    -- transactions is a restatement of the prior UB, already summed in
    -- non_ib_lines. Decided per account, never per bag.
    SELECT eib.account_number, eib.debit_amount, eib.credit_amount, eib.dimensions
    FROM earliest_ib eib
    WHERE NOT EXISTS (
      SELECT 1
      FROM non_ib_lines nil
      WHERE nil.account_number = eib.account_number
        AND nil.entry_date < eib.entry_date
    )
  )
  SELECT e.account_number, e.debit_amount, e.credit_amount, e.dimensions FROM effective_ib e
  UNION ALL
  SELECT n.account_number, n.debit_amount, n.credit_amount, n.dimensions FROM non_ib_lines n;
$$;

REVOKE ALL ON FUNCTION public.prior_opening_balance_lines(uuid, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prior_opening_balance_lines(uuid, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.prior_opening_balance_lines(uuid, date) IS
  'Effective prior balance-sheet lines (with dimension bags) behind a derived IB: every line of the earliest posted IB entry per account unless non-IB activity predates it, plus all posted non-IB, non-storno lines before p_period_start. Issue #3313.';

-- 2 ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.compute_prior_opening_balances(uuid, date);

CREATE FUNCTION public.compute_prior_opening_balances(
  p_company_id uuid,
  p_period_start date,
  p_dimensions jsonb DEFAULT NULL
)
RETURNS TABLE (account_number text, debit numeric, credit numeric)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    l.account_number,
    SUM(l.debit_amount)::numeric  AS debit,
    SUM(l.credit_amount)::numeric AS credit
  FROM public.prior_opening_balance_lines(p_company_id, p_period_start) l
  WHERE p_dimensions IS NULL OR l.dimensions @> p_dimensions
  GROUP BY l.account_number;
$$;

REVOKE ALL ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) IS
  'Derived IB per balance-sheet account from prior history (no IB entry on the period). p_dimensions scopes it to lines whose bag contains the filter, e.g. {"6":"P1"}: a project''s opening balance. Issue #3313 (supersedes 20260421180000).';

-- 3 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.compute_object_closing_balances(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_dim_nos text[]
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_period_start date;
  v_ob_entry_id uuid;
BEGIN
  SELECT fp.period_start, fp.opening_balance_entry_id
    INTO v_period_start, v_ob_entry_id
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'compute_object_closing_balances: fiscal period % not found for company', p_fiscal_period_id
      USING ERRCODE = 'no_data_found';
  END IF;

  IF p_dim_nos IS NULL OR cardinality(p_dim_nos) = 0 THEN
    RETURN '[]'::jsonb;
  END IF;

  RETURN (
    WITH ib AS (
      -- The year's IB as getOpeningBalances reads it: the linked IB entry's
      -- lines (no status filter), or the prior-history fallback.
      SELECT l.account_number, l.debit_amount, l.credit_amount, l.dimensions
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE v_ob_entry_id IS NOT NULL
        AND e.id = v_ob_entry_id
        AND e.company_id = p_company_id
      UNION ALL
      SELECT p.account_number, p.debit_amount, p.credit_amount, p.dimensions
      FROM public.prior_opening_balance_lines(p_company_id, v_period_start) p
      WHERE v_ob_entry_id IS NULL
    ),
    activity AS (
      -- The year's lines as the trial balance reads them with the closing
      -- entry included: posted and reversed entries of the period, the IB
      -- entry excluded (it is the IB above).
      SELECT l.account_number, l.debit_amount, l.credit_amount, l.dimensions
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e ON e.id = l.journal_entry_id
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.status IN ('posted', 'reversed')
        AND (v_ob_entry_id IS NULL OR e.id <> v_ob_entry_id)
    ),
    projected AS (
      SELECT
        x.account_number,
        x.debit_amount - x.credit_amount AS net,
        (SELECT COALESCE(jsonb_object_agg(k.key, k.value), '{}'::jsonb)
           FROM jsonb_each(x.dimensions) AS k(key, value)
          WHERE k.key = ANY (p_dim_nos)) AS bag
      FROM (SELECT * FROM ib UNION ALL SELECT * FROM activity) x
      WHERE substr(x.account_number, 1, 1) BETWEEN '1' AND '2'
        AND x.dimensions <> '{}'::jsonb
    ),
    grouped AS (
      SELECT pr.account_number, pr.bag, SUM(pr.net) AS net
      FROM projected pr
      WHERE pr.bag <> '{}'::jsonb
      GROUP BY pr.account_number, pr.bag
    )
    SELECT COALESCE(
      jsonb_agg(
        jsonb_build_object('account_number', g.account_number, 'dimensions', g.bag, 'net', g.net)
        ORDER BY g.account_number, g.bag::text
      ),
      '[]'::jsonb
    )
    FROM grouped g
    WHERE g.net <> 0
  );
END;
$$;

REVOKE ALL ON FUNCTION public.compute_object_closing_balances(uuid, uuid, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_object_closing_balances(uuid, uuid, text[]) TO authenticated, service_role;

COMMENT ON FUNCTION public.compute_object_closing_balances(uuid, uuid, text[]) IS
  'Closing balance per (balance-sheet account, line bag projected onto p_dim_nos) for a fiscal period, read like the trial balance with the closing entry included. Nonzero tagged groups only; the untagged remainder is the account total minus these. Feeds the year-end IB split per project. Issue #3313.';

NOTIFY pgrst, 'reload schema';
