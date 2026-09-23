-- get_onboarding_books_summary: the four ledger figures behind the onboarding
-- Genomlysning (GET /api/onboarding/findings), summed in SQL from the
-- company's own entries.
--
-- loadBooksFindings (lib/onboarding/findings.ts) used to download journal
-- lines through a PostgREST embed (journal_entry_lines with
-- journal_entries!inner filtered on company_id) and sum them in JS. Hosted
-- PostgREST puts a LIMIT inside the embed's LATERAL subquery, which stops
-- Postgres from pulling it up: the only possible plan walks EVERY tenant's
-- journal lines and probes journal_entries once per line. On prod that was
-- about 2.3M buffers and 4 s per page for a company with a few hundred lines,
-- and the endpoint ran into the statement timeout.
--
-- This function starts from the company's entries
-- (idx_journal_entries_company_posted_date_id) and joins their lines
-- (idx_journal_entry_lines_entry_id), so the cost follows the company's own
-- ledger, never the table.
--
-- Semantics are a verbatim port of the JS it replaces. Nothing here is new
-- accounting logic:
--
--   base set     company, status IN ('posted','reversed'); a reversed entry
--                stays together with its storno so the pair nets to zero
--   period       the fiscal period with the latest period_start that has at
--                least one line on a base-set entry dated inside
--                [period_start, period_end]. Matched on entry_date, not
--                fiscal_period_id, exactly as before. Empty and future
--                periods cost one index probe each.
--   revenue      class 3 of that period, credit minus debit
--   result       classes 3 to 8 of that period, credit minus debit
--   vat_balance  26xx across all time, credit minus debit (positive = owed)
--   ledger_1630  1630 across all time, debit minus credit (positive = asset)
--
-- revenue, result and period_name are NULL when no period has lines.
-- vat_balance and ledger_1630 are 0 when nothing is booked there; the caller
-- decides whether an empty company shows them at all. Sums are exact
-- numerics; the caller rounds to öre.
--
-- SECURITY INVOKER: RLS on fiscal_periods / journal_entries /
-- journal_entry_lines applies exactly as it did to the PostgREST path, so a
-- non-member gets an empty summary. The explicit company_id predicates are
-- defence in depth for service-role callers.
--
-- pg-test: tests/pg/onboarding-books-summary-rpc.pg.test.ts

CREATE FUNCTION public.get_onboarding_books_summary(p_company_id uuid)
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
BEGIN
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
    ), 0),
    COALESCE(sum(COALESCE(l.credit_amount, 0) - COALESCE(l.debit_amount, 0)) FILTER (
      WHERE l.account_number >= '2600' AND l.account_number <= '2699'
    ), 0),
    COALESCE(sum(COALESCE(l.debit_amount, 0) - COALESCE(l.credit_amount, 0)) FILTER (
      WHERE l.account_number = '1630'
    ), 0)
    INTO v_revenue, v_result, v_vat_balance, v_ledger_1630
  FROM public.journal_entries e
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE e.company_id = p_company_id
    AND e.status IN ('posted', 'reversed');

  RETURN jsonb_build_object(
    'period_name', CASE WHEN v_has_period THEN v_period_name END,
    'revenue', CASE WHEN v_has_period THEN v_revenue END,
    'result', CASE WHEN v_has_period THEN v_result END,
    'vat_balance', v_vat_balance,
    'ledger_1630', v_ledger_1630
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_onboarding_books_summary(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_onboarding_books_summary(uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_onboarding_books_summary(uuid) IS
  'Latest-period revenue/result plus all-time 26xx and 1630 balances for one company, summed company-first; the SQL side of loadBooksFindings.';

NOTIFY pgrst, 'reload schema';
