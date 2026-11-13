-- get_onboarding_books_summary reads the ledger summaries (2026-11-13).
--
-- Each of its three statements read journal_entry_lines for the whole
-- company: the latest fiscal year with entries, revenue and result for that
-- year, and the 26xx, 1630 and skattekonto balances, each counted from the
-- account's latest ingående balans on (20261112181800). The function runs as
-- the caller, so every line also passed the journal_entry_lines_select
-- policy, which re-reads the parent verifikat. Cost follows the company's
-- whole history with a large constant. Production, read-only as a member of
-- the largest company (154 336 verifikat, 464 132 lines), 2026-11-12: no
-- answer in 15 s with a warm cache; the authenticated limit is 8 s. The
-- summary feeds the onboarding findings (lib/onboarding/findings.ts).
--
-- ledger_account_days (20261023093900) holds, per company, account and day,
-- the debit, credit and line count of every posted and reversed verifikat,
-- which is the set this function reads, kept in step by triggers in the same
-- transaction as the lines. get_account_usage_counts and the reports read
-- it already (20261112214303). Now, when the company's summaries are built:
--   * the year: the latest fiscal period with a day whose summary slots sum
--     to lines (a removal on another backend writes a negative slot row,
--     folded only by compact_ledger_account_days, so no single row decides);
--   * revenue and result: sums over that period's summary rows;
--   * the balances: sums over each account's summary rows from its IB floor
--     on, the floor from public.account_ib_floor as before. The floors are
--     read once per account (MATERIALIZED). Left to the planner, the lateral
--     call was joined in per summary row: 3 954 calls and 3.6 s for the
--     largest company.
-- The same statements on production, as that member: 60 to 64 ms warm,
-- 9 580 buffers. The balances were compared with the line form of
-- 20261112181800 on ten companies with two IB years (four of them with
-- skattekonto account 2012): equal on every figure. The year matched the
-- line form on those ten and the two largest companies; revenue and result
-- are the sums compared row for row on 2026-11-12 (three companies, one
-- with 54 734 verifikat). Cost now follows the company's account-days
-- (19 102 rows for the largest company), not its lines.
--
-- A company whose summaries are not built (ledger_account_days_ready false)
-- keeps the line path of 20261112181800, verbatim, as every other reader of
-- the summaries does. All companies on production are built.
--
-- Signature, payload, SECURITY INVOKER, search_path and grants unchanged.
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

  IF public.ledger_account_days_ready(p_company_id) THEN
    -- The ledger summaries: per account and day of the posted and reversed
    -- verifikat, in one row per writer slot until compaction folds them. A
    -- line removed on another backend leaves a negative row beside the
    -- positive one, so a day has lines only when its slots sum above zero:
    -- the rule every reader of the summaries uses.
    SELECT fp.name, fp.period_start, fp.period_end
      INTO v_period_name, v_period_start, v_period_end
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND EXISTS (
        SELECT 1
        FROM public.ledger_account_days d
        WHERE d.company_id = p_company_id
          AND d.entry_date >= fp.period_start
          AND d.entry_date <= fp.period_end
        GROUP BY d.fiscal_period_id, d.account_number, d.entry_date
        HAVING sum(d.line_count) > 0
      )
    ORDER BY fp.period_start DESC
    LIMIT 1;
    v_has_period := FOUND;

    SELECT
      COALESCE(sum(d.credit - d.debit) FILTER (
        WHERE substr(d.account_number, 1, 1) = '3'
      ), 0),
      COALESCE(sum(d.credit - d.debit) FILTER (
        WHERE substr(d.account_number, 1, 1) IN ('3', '4', '5', '6', '7', '8')
      ), 0)
      INTO v_revenue, v_result
    FROM public.ledger_account_days d
    WHERE v_has_period
      AND d.company_id = p_company_id
      AND d.entry_date >= v_period_start
      AND d.entry_date <= v_period_end;

    -- The balances: each account from its latest ingående balans on. The
    -- floors are read once per account before the join (MATERIALIZED).
    WITH floors AS MATERIALIZED (
      SELECT a.account_number, f.floor_date
      FROM (
        SELECT DISTINCT d.account_number
        FROM public.ledger_account_days d
        WHERE d.company_id = p_company_id
          AND (
            (d.account_number >= '2600' AND d.account_number <= '2699')
            OR d.account_number = '1630'
            OR d.account_number = v_skattekonto_account
          )
      ) a
      LEFT JOIN LATERAL public.account_ib_floor(p_company_id, a.account_number) f ON true
    )
    SELECT
      COALESCE(sum(d.credit - d.debit) FILTER (
        WHERE d.account_number >= '2600' AND d.account_number <= '2699'
      ), 0),
      COALESCE(sum(d.debit - d.credit) FILTER (WHERE d.account_number = '1630'), 0),
      COALESCE(sum(d.debit - d.credit) FILTER (WHERE d.account_number = v_skattekonto_account), 0)
      INTO v_vat_balance, v_ledger_1630, v_ledger_skattekonto
    FROM public.ledger_account_days d
    JOIN floors fl ON fl.account_number = d.account_number
    WHERE d.company_id = p_company_id
      AND (fl.floor_date IS NULL OR d.entry_date >= fl.floor_date);
  ELSE
    -- Summaries not built for this company: the lines, as in 20261112181800.
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
  END IF;

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
  'Latest-period revenue/result plus the 26xx, 1630 and skattekonto-account balances for one company, each account counted from its latest ingående balans on (account_ib_floor). Read from ledger_account_days once the company''s summaries are built, from the lines before that; the SQL side of loadBooksFindings.';

NOTIFY pgrst, 'reload schema';
