-- A derived opening balance carries a result that was never moved to equity.
--
-- A year without a linked IB verifikat opens on a balance derived from the
-- earlier years' balance-sheet lines (compute_prior_opening_balances: the
-- ledger summaries for a built company since 20261024110000, the line path
-- prior_opening_balance_lines otherwise). Equity
-- there held only what class-2 lines carried, so a year that ended without a
-- booked resultatavslut left its result out, and every later balance sheet
-- was off by exactly that amount. That year can be:
--   - an SIE year from a system that carries the result in next year's #IB
--     without a voucher (Fortnox);
--   - a year klarmarkerat as closed elsewhere;
--   - a year not yet closed in Accounted.
-- Such years are common.
--
-- The derived opening balance now reads such a year as if it had been closed.
-- Each ended fiscal year gets one line on the form's closing account, dated
-- the year's last day, carrying the result still on its result accounts.
-- The closing accounts are lib/company/forms' resultClosingAccounts: 2099 for
-- aktiebolag and ekonomisk förening, 2010 for enskild firma, 2069 for ideell
-- förening. Every entry balances, so the result still on the result accounts
-- is what the year's balance-sheet lines are out of balance by: each path
-- reads it off the sums it already makes (the history lines, or the summary
-- days less the left-out lines), with no second pass. Both paths add the same
-- lines; tests/pg/prior-opening-balances-summaries.pg.test.ts holds them equal.
--
-- A booked closing (our year-end, an imported resultatavslut, an 8999 against
-- 2099) nets the year to zero, so the line is gone the moment the real
-- closing is booked. Balance continuity holds per balance-sheet post:
-- Årets resultat is in last year's closing balance sheet as beräknat
-- resultat. On the closing account itself the opening balance is last year's
-- UB plus the result still left on the result accounts, the same as the
-- source system's own #IB.
--
-- The lines take part in the per-account earliest-IB rule exactly as a
-- booked closing would. An IB verifikat dated after them that already
-- carries the result on 2099 is a restatement, and its 2099 line drops
-- instead of counting the result twice.
--
-- Lines are assigned to the ended year whose date range holds them; lines
-- dated before the first year are closed with the first year. A dimension
-- filter never matches the lines (their bag is empty), so a project's
-- opening balance is unchanged. compute_object_closing_balances skips
-- untagged lines.

-- 1 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.result_closing_account(p_entity_type text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public
AS $$
  -- The SQL twin of resultClosingAccounts(form).closing
  -- (src/lib/company/forms/*.ts); tests/pg/legal-form-profiles.pg.test.ts
  -- keeps the two equal. An unknown form returns NULL: no line, as before.
  SELECT CASE p_entity_type
    WHEN 'aktiebolag' THEN '2099'
    WHEN 'ekonomisk_forening' THEN '2099'
    WHEN 'enskild_firma' THEN '2010'
    WHEN 'ideell_forening' THEN '2069'
  END;
$$;

REVOKE ALL ON FUNCTION public.result_closing_account(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.result_closing_account(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.result_closing_account(text) IS
  'The account a legal form closes the year''s result to (2099 AB and ekonomisk förening, 2010 enskild firma, 2069 ideell förening): the SQL twin of resultClosingAccounts in lib/company/forms.';

-- 2 ---------------------------------------------------------------------------

-- Body of 20261001213328 unchanged except that non_ib_lines is now the
-- real history (history_lines) plus the virtual closing lines.
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
  history_lines AS (
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
  ended_years AS (
    -- Every fiscal year that ended before the requested start, with the end
    -- of the year before it: a line belongs to the year whose
    -- (previous_end, period_end] range holds its date.
    SELECT
      fp.period_end,
      LAG(fp.period_end) OVER (ORDER BY fp.period_end) AS previous_end
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.period_end < p_period_start
  ),
  virtual_closings AS (
    -- Every one of these entries balances, so what a year's lines leave
    -- class 1-2 out of balance by is exactly the result still on its result
    -- accounts (net debit here = profit there). One line per ended year that
    -- has one, on the form's closing account; none for a form without one.
    SELECT
      a.account_number,
      CASE WHEN y.net_debit < 0 THEN -y.net_debit ELSE 0 END AS debit_amount,
      CASE WHEN y.net_debit > 0 THEN y.net_debit ELSE 0 END AS credit_amount,
      '{}'::jsonb AS dimensions,
      y.period_end AS entry_date
    FROM (
      SELECT ey.period_end, SUM(d.net_debit) AS net_debit
      FROM ended_years ey
      JOIN (
        SELECT h.entry_date, SUM(coalesce(h.debit_amount, 0) - coalesce(h.credit_amount, 0)) AS net_debit
        FROM history_lines h
        GROUP BY h.entry_date
      ) d
        ON d.entry_date <= ey.period_end
       AND (ey.previous_end IS NULL OR d.entry_date > ey.previous_end)
      GROUP BY ey.period_end
      HAVING SUM(d.net_debit) <> 0
    ) y
    CROSS JOIN (
      SELECT public.result_closing_account(c.entity_type) AS account_number
      FROM public.companies c
      WHERE c.id = p_company_id
    ) a
    WHERE a.account_number IS NOT NULL
  ),
  non_ib_lines AS (
    -- The virtual closings count as activity on their day, as a booked
    -- closing would.
    SELECT h.account_number, h.debit_amount, h.credit_amount, h.dimensions, h.entry_date
    FROM history_lines h
    UNION ALL
    SELECT v.account_number, v.debit_amount, v.credit_amount, v.dimensions, v.entry_date
    FROM virtual_closings v
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
  'Effective prior balance-sheet lines (with dimension bags) behind a derived IB: every line of the earliest posted IB entry per account unless non-IB activity predates it, plus all posted non-IB, non-storno lines before p_period_start, plus one untagged line per ended year whose result is still on the result accounts, on the form''s closing account (2099/2010/2069). Issues #3313, 2026-10-24.';

-- 3 ---------------------------------------------------------------------------

-- Body of 20261024110000 unchanged except three things on the summary path:
--   - the summary days before the period are read once (class12_days), for
--     the per-account sums as before and for the per-day history below;
--   - virtual_closings: the same lines as the line path, from the summary
--     days less the left-out lines;
--   - they count in the earliest-IB rule (virtual_before_ib) and are added
--     when no filter applies.
CREATE OR REPLACE FUNCTION public.compute_prior_opening_balances(
  p_company_id uuid,
  p_period_start date,
  p_dimensions jsonb DEFAULT NULL
)
RETURNS TABLE (account_number text, debit numeric, credit numeric)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
-- One company's rows: starting parallel workers costs more than it saves.
SET max_parallel_workers_per_gather TO 0
-- Planned for the company it is called with.
SET plan_cache_mode TO force_custom_plan
AS $$
#variable_conflict use_column
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_dim_no text;
  v_code text;
  v_summary boolean := false;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN;
    END IF;
  END IF;

  IF public.ledger_account_days_ready(p_company_id) THEN
    IF p_dimensions IS NULL THEN
      v_summary := true;
    ELSIF jsonb_typeof(p_dimensions) = 'object'
          AND (SELECT count(*) FROM jsonb_object_keys(p_dimensions)) = 1 THEN
      SELECT d.key, d.value #>> '{}' INTO v_dim_no, v_code
      FROM jsonb_each(p_dimensions) d
      WHERE jsonb_typeof(d.value) = 'string';
      v_summary := v_dim_no IS NOT NULL;
    END IF;
  END IF;

  IF NOT v_summary THEN
    RETURN QUERY
    SELECT l.account_number, SUM(l.debit_amount)::numeric, SUM(l.credit_amount)::numeric
    FROM public.prior_opening_balance_lines(p_company_id, p_period_start) l
    WHERE p_dimensions IS NULL OR l.dimensions @> p_dimensions
    GROUP BY l.account_number;
    RETURN;
  END IF;

  RETURN QUERY
  WITH left_out_lines AS MATERIALIZED (
    -- The lines of the counted entries before the period that the sum leaves
    -- out: reversed entries, stornos and IB verifikat.
    SELECT l.account_number,
           coalesce(l.debit_amount, 0) AS debit,
           coalesce(l.credit_amount, 0) AS credit,
           l.dimensions,
           e.id AS entry_id,
           e.entry_date,
           e.created_at,
           e.status = 'posted' AND e.source_type = 'opening_balance' AS is_ib
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.entry_date < p_period_start
      AND (e.status = 'reversed'
           OR (e.status = 'posted' AND e.source_type IN ('storno', 'opening_balance')))
      AND substr(l.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  earliest_ib AS (
    -- Every line of the earliest posted IB verifikat per account.
    SELECT r.account_number, r.debit, r.credit, r.dimensions, r.entry_date
    FROM (
      SELECT x.account_number, x.debit, x.credit, x.dimensions, x.entry_date,
             dense_rank() OVER (PARTITION BY x.account_number
                                ORDER BY x.entry_date, x.created_at, x.entry_id) AS rnk
      FROM left_out_lines x
      WHERE x.is_ib
    ) r
    WHERE r.rnk = 1
  ),
  ib_day AS (
    SELECT DISTINCT i.account_number, i.entry_date FROM earliest_ib i
  ),
  class12_days AS MATERIALIZED (
    -- The summaries before the period on the balance-sheet accounts.
    SELECT d.account_number, d.entry_date, d.debit, d.credit, d.line_count
    FROM public.ledger_account_days d
    WHERE d.company_id = p_company_id
      AND d.entry_date < p_period_start
      AND substr(d.account_number, 1, 1) BETWEEN '1' AND '2'
  ),
  account_days AS (
    -- The summaries before the period per account, and for an account with
    -- an IB verifikat how many of its lines come before that day.
    SELECT d.account_number,
           sum(d.debit) AS debit,
           sum(d.credit) AS credit,
           sum(d.line_count) AS line_count,
           coalesce(sum(d.line_count) FILTER (WHERE d.entry_date < b.entry_date), 0) AS before_ib
    FROM class12_days d
    LEFT JOIN ib_day b ON b.account_number = d.account_number
    GROUP BY d.account_number
  ),
  dimension_days AS (
    SELECT m.account_number, sum(m.debit) AS debit, sum(m.credit) AS credit, sum(m.line_count) AS line_count
    FROM public.ledger_dimension_days m
    WHERE v_dim_no IS NOT NULL
      AND m.company_id = p_company_id
      AND m.dim_no = v_dim_no
      AND m.code = v_code
      AND m.entry_date < p_period_start
      AND substr(m.account_number, 1, 1) BETWEEN '1' AND '2'
    GROUP BY m.account_number
  ),
  counted AS (
    SELECT a.account_number, a.debit, a.credit, a.line_count FROM account_days a WHERE v_dim_no IS NULL
    UNION ALL
    SELECT m.account_number, m.debit, m.credit, m.line_count FROM dimension_days m
  ),
  left_out AS (
    SELECT x.account_number, sum(x.debit) AS debit, sum(x.credit) AS credit, count(*) AS line_count
    FROM left_out_lines x
    WHERE p_dimensions IS NULL OR x.dimensions @> p_dimensions
    GROUP BY x.account_number
  ),
  left_out_before_ib AS (
    SELECT x.account_number, count(*) AS line_count
    FROM left_out_lines x
    JOIN ib_day b ON b.account_number = x.account_number
    WHERE x.entry_date < b.entry_date
    GROUP BY x.account_number
  ),
  ended_years AS (
    -- As on the line path: a day belongs to the year whose
    -- (previous_end, period_end] range holds it.
    SELECT fp.period_end,
           lag(fp.period_end) OVER (ORDER BY fp.period_end) AS previous_end
    FROM public.fiscal_periods fp
    WHERE fp.company_id = p_company_id
      AND fp.period_end < p_period_start
  ),
  history_days AS (
    -- The counted history's net debit per day (all of it, before any
    -- filter): the summary days less the left-out lines.
    SELECT h.entry_date, sum(h.net_debit) AS net_debit
    FROM (
      SELECT d.entry_date, d.debit - d.credit AS net_debit FROM class12_days d
      UNION ALL
      SELECT x.entry_date, x.credit - x.debit FROM left_out_lines x
    ) h
    GROUP BY h.entry_date
  ),
  virtual_closings AS (
    -- The line path's virtual closing lines, on the same sums.
    SELECT a.account_number,
           CASE WHEN y.net_debit < 0 THEN -y.net_debit ELSE 0 END AS debit,
           CASE WHEN y.net_debit > 0 THEN y.net_debit ELSE 0 END AS credit,
           y.period_end AS entry_date
    FROM (
      SELECT ey.period_end, sum(h.net_debit) AS net_debit
      FROM ended_years ey
      JOIN history_days h
        ON h.entry_date <= ey.period_end
       AND (ey.previous_end IS NULL OR h.entry_date > ey.previous_end)
      GROUP BY ey.period_end
      HAVING sum(h.net_debit) <> 0
    ) y
    CROSS JOIN (
      SELECT public.result_closing_account(c.entity_type) AS account_number
      FROM public.companies c
      WHERE c.id = p_company_id
    ) a
    WHERE a.account_number IS NOT NULL
  ),
  virtual_before_ib AS (
    SELECT v.account_number, count(*) AS line_count
    FROM virtual_closings v
    JOIN ib_day b ON b.account_number = v.account_number
    WHERE v.entry_date < b.entry_date
    GROUP BY v.account_number
  ),
  effective_ib AS (
    -- The earliest IB counts for an account with no counted line before it,
    -- a virtual closing included (decided before the filter, as on the line
    -- path).
    SELECT i.account_number, i.debit, i.credit
    FROM earliest_ib i
    LEFT JOIN account_days a ON a.account_number = i.account_number
    LEFT JOIN left_out_before_ib o ON o.account_number = i.account_number
    LEFT JOIN virtual_before_ib vb ON vb.account_number = i.account_number
    WHERE coalesce(a.before_ib, 0) - coalesce(o.line_count, 0) + coalesce(vb.line_count, 0) = 0
      AND (p_dimensions IS NULL OR i.dimensions @> p_dimensions)
  ),
  prior_lines AS (
    SELECT c.account_number,
           c.debit - coalesce(o.debit, 0) AS debit,
           c.credit - coalesce(o.credit, 0) AS credit
    FROM counted c
    LEFT JOIN left_out o ON o.account_number = c.account_number
    WHERE c.line_count - coalesce(o.line_count, 0) > 0
  )
  SELECT u.account_number, sum(u.debit)::numeric, sum(u.credit)::numeric
  FROM (
    SELECT p.account_number, p.debit, p.credit FROM prior_lines p
    UNION ALL
    SELECT e.account_number, e.debit, e.credit FROM effective_ib e
    UNION ALL
    -- Untagged, as on the line path: a filter never matches them.
    SELECT v.account_number, v.debit, v.credit FROM virtual_closings v WHERE p_dimensions IS NULL
  ) u
  GROUP BY u.account_number;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) IS
  'Derived IB per balance-sheet account from prior history (no IB entry on the period). p_dimensions scopes it to lines whose bag contains the filter, e.g. {"6":"P1"}: a project''s opening balance. Issue #3313. Reads ledger_account_days / ledger_dimension_days once the company is built and the filter is at most one value (20261024110000); the same rows as prior_opening_balance_lines, including the line per ended year whose result is still on the result accounts (2026-10-24).';

NOTIFY pgrst, 'reload schema';
