-- compute_prior_opening_balances reads the ledger summaries.
--
-- Why: a fiscal year with no linked IB verifikat opens on every earlier line
-- (getOpeningBalances behind saldobalans, huvudbok, balansrapport and
-- resultatrapport; the KPI report; the byrå overview). A company with a
-- large ledger often has no IB verifikat on its current year, so each of
-- those reports summed every prior journal line under the lines' RLS
-- policy, which can take seconds and grows with every year of history. The
-- summaries (20261023093900_ledger_account_days) already hold those sums
-- per account and day.
--
-- What it returns is unchanged, to the öre (prior_opening_balance_lines,
-- 20261001213328): per balance-sheet account (class 1-2), the posted lines
-- before the period that are neither storno nor IB, plus every line of the
-- earliest posted IB verifikat for an account with no such line before it.
-- The summaries count the posted and reversed entries of every kind, so the
-- sum is theirs less the lines of the entries that rule leaves out: reversed
-- entries, stornos and IB verifikat, read directly through the partial index
-- below (none for most companies). Whether an account's IB counts is
-- decided the same way, by line counts: the summaries' lines before the IB
-- day less the left-out ones.
--
-- An amount counts as 0 when NULL, as it does in the summaries.
--
-- The summaries answer no filter and a filter on one string value. Anything
-- else (several values, the empty object) keeps the line path, which is the
-- function as it was.
--
-- SECURITY DEFINER, like verifikat_without_documents: the lines' RLS policy
-- re-checks the parent entry once per line, which was most of the cost. The
-- caller's access is checked here instead, and an API-role caller outside the
-- company gets no rows, as RLS gave them before.

-- The entries the prior lines leave out, per company and day.
CREATE INDEX IF NOT EXISTS journal_entries_prior_excluded_idx
  ON public.journal_entries (company_id, entry_date)
  WHERE status = 'reversed'
     OR (status = 'posted' AND source_type IN ('storno', 'opening_balance'));

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
  account_days AS (
    -- The summaries before the period per account, and for an account with
    -- an IB verifikat how many of its lines come before that day.
    SELECT d.account_number,
           sum(d.debit) AS debit,
           sum(d.credit) AS credit,
           sum(d.line_count) AS line_count,
           coalesce(sum(d.line_count) FILTER (WHERE d.entry_date < b.entry_date), 0) AS before_ib
    FROM public.ledger_account_days d
    LEFT JOIN ib_day b ON b.account_number = d.account_number
    WHERE d.company_id = p_company_id
      AND d.entry_date < p_period_start
      AND substr(d.account_number, 1, 1) BETWEEN '1' AND '2'
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
  effective_ib AS (
    -- The earliest IB counts for an account with no counted line before it
    -- (decided before the filter, as on the line path).
    SELECT i.account_number, i.debit, i.credit
    FROM earliest_ib i
    LEFT JOIN account_days a ON a.account_number = i.account_number
    LEFT JOIN left_out_before_ib o ON o.account_number = i.account_number
    WHERE coalesce(a.before_ib, 0) - coalesce(o.line_count, 0) = 0
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
  ) u
  GROUP BY u.account_number;
END;
$$;

REVOKE ALL ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.compute_prior_opening_balances(uuid, date, jsonb) IS
  'Derived IB per balance-sheet account from prior history (no IB entry on the period). p_dimensions scopes it to lines whose bag contains the filter, e.g. {"6":"P1"}: a project''s opening balance. Issue #3313. Reads ledger_account_days / ledger_dimension_days once the company is built and the filter is at most one value (20261024110000); the same rows as prior_opening_balance_lines.';

NOTIFY pgrst, 'reload schema';
