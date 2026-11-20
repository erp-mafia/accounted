-- get_onboarding_books_summary: the three balances count each account from
-- its latest ingående balans on, as every other balance reader does.
--
-- vat_balance (2600-2699), ledger_1630 and ledger_skattekonto were sums over
-- every posting the company has. An ingående balans restates everything
-- booked before it: the year-end rollover, each SIE year import and
-- set_opening_balances post one opening_balance verifikat on the fiscal
-- year's first day and leave the earlier years in the ledger. A sum across it
-- counts those years once more per IB. Two imported years (IB 1630 = 5 000
-- and +2 000 in 2024, IB 1630 = 7 000 and -1 000 in 2025) read 13 000 here
-- where /skattekonto and the balance sheet read 6 000.
--
-- Most companies with two or more IB verifikat and something on 1630 got a
-- different skattekonto balance from this function than from the floored
-- read.
--
-- The floor is public.account_ib_floor (20261101180100), the rule the bank
-- reconciliation and the skattekonto status already read: the latest posted
-- opening_balance verifikat on a fiscal year's first day with a line on the
-- account, a date whose IB verifikat cancel on the account being none. An
-- account without an IB still sums all history, so a company that never
-- imported or closed a year reads exactly as before.
--
-- Changed: the balances only. The period, revenue and result are the
-- statements of 20261015030000 verbatim. Signature, SECURITY INVOKER,
-- search_path, ACL and the keys of the payload are unchanged, so the app
-- deployed before this reads the new function as it read the old one.
--
-- pg-test: tests/pg/onboarding-books-summary-rpc.pg.test.ts

CREATE OR REPLACE FUNCTION public.get_onboarding_books_summary(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
DECLARE
  v_period_name text;
  v_period_start date;
  v_period_end date;
  v_has_period boolean;
  v_revenue numeric;
  v_result numeric;
  v_vat_balance numeric;
  v_ledger_1630 numeric;
  v_skattekonto_account text;
  v_ledger_skattekonto numeric;
BEGIN
  v_skattekonto_account := public.company_skattekonto_account(p_company_id);

  SELECT fp.name, fp.period_start, fp.period_end
    INTO v_period_name, v_period_start, v_period_end
  FROM public.fiscal_periods fp
  WHERE fp.company_id = p_company_id
    AND EXISTS (
      SELECT 1
      FROM public.journal_entries e
      JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id
        AND e.status IN ('posted', 'reversed')
        AND e.entry_date >= fp.period_start
        AND e.entry_date <= fp.period_end
    )
  ORDER BY fp.period_start DESC
  LIMIT 1;
  v_has_period := FOUND;

  SELECT
    COALESCE(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)) FILTER (
      WHERE v_has_period
        AND e.entry_date >= v_period_start
        AND e.entry_date <= v_period_end
        AND substr(l.account_number, 1, 1) = '3'
    ), 0),
    COALESCE(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)) FILTER (
      WHERE v_has_period
        AND e.entry_date >= v_period_start
        AND e.entry_date <= v_period_end
        AND substr(l.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
    ), 0)
    INTO v_revenue, v_result
  FROM public.journal_entries e
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE e.company_id = p_company_id
    AND e.status IN ('posted', 'reversed');

  -- The balances: each account from its latest ingående balans on. The lines
  -- are read company-first, as above; the floor is one small read per account
  -- that has a line.
  WITH balance_lines AS (
    SELECT l.account_number,
           e.entry_date,
           COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0) AS amount
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.status IN ('posted', 'reversed')
      AND (
        (l.account_number >= '2600' AND l.account_number <= '2699')
        OR l.account_number = '1630'
        OR l.account_number = v_skattekonto_account
      )
  ),
  floors AS (
    SELECT a.account_number, f.floor_date
    FROM (SELECT DISTINCT bl.account_number FROM balance_lines bl) a
    LEFT JOIN LATERAL public.account_ib_floor(p_company_id, a.account_number) f ON true
  ),
  counted AS (
    SELECT bl.account_number, bl.amount
    FROM balance_lines bl
    JOIN floors fl ON fl.account_number = bl.account_number
    WHERE fl.floor_date IS NULL OR bl.entry_date >= fl.floor_date
  )
  SELECT
    COALESCE(-sum(c.amount) FILTER (
      WHERE c.account_number >= '2600' AND c.account_number <= '2699'
    ), 0),
    COALESCE(sum(c.amount) FILTER (WHERE c.account_number = '1630'), 0),
    COALESCE(sum(c.amount) FILTER (WHERE c.account_number = v_skattekonto_account), 0)
    INTO v_vat_balance, v_ledger_1630, v_ledger_skattekonto
  FROM counted c;

  RETURN jsonb_build_object(
    'period_name', CASE WHEN v_has_period THEN v_period_name END,
    'revenue', CASE WHEN v_has_period THEN v_revenue END,
    'result', CASE WHEN v_has_period THEN v_result END,
    'vat_balance', v_vat_balance,
    'ledger_1630', v_ledger_1630,
    'skattekonto_account', v_skattekonto_account,
    'ledger_skattekonto', v_ledger_skattekonto
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_onboarding_books_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_onboarding_books_summary(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_onboarding_books_summary(uuid) IS
  'Latest-period revenue/result plus the 26xx, 1630 and skattekonto-account balances for one company, each account counted from its latest ingående balans on (account_ib_floor), summed company-first; the SQL side of loadBooksFindings.';

NOTIFY pgrst, 'reload schema';
