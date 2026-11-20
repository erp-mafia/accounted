-- year_end_chain_entry_ids: 'exclude-all-year-end' also leaves out a
-- resultatavslut booked outside the year-end run.
--
-- The operational resultaträkning (Resultaträkning, Resultatrapport, KPI,
-- dimension P&L, kassaflödesanalys) reads a year before the bokslut with
-- 'exclude-all-year-end'. That mode keyed on source_type 'year_end' alone, so
-- a resultatavslut booked in the previous system (SIE-imported, source_type
-- 'import') or by hand ('manual'), which zeroes every result account straight
-- against 2099, stayed in, and the year's resultaträkning read about 0 kr on
-- every row while the balance sheet was right. 'exclude-final' has recognised
-- such an entry by shape since 20260924202408 (result_closing_entry_ids); the
-- operational mode never did.
--
-- The set now also holds every entry of result_closing_entry_ids (last day,
-- result accounts against 2099/2019/2069 only, not a storno) that
--   - books a result account outside årets resultat (8990-8999): a pure
--     8999 -> 2099 omföring stays, since the resultaträkning leaves 899x out
--     by account and the Resultatrapport lists booked 8999 (2026-09-09, #2455);
--   - leaves every such account it books at zero for the year. That is what
--     closing an account is. An öre rounding booked against 2099, a voucher
--     that books the result a second time and one that moves only part of an
--     account all leave the account non-zero and stay, as before.
--
-- The line-level paths of get_trial_balance_aggregates and
-- get_kpi_report_aggregates read the same function instead of their own copy
-- of the source_type rule, so the summary and line paths cannot drift.
-- ledger_period_account_days and ledger_period_dimension_days subtract an
-- excluded entry once even when callers name it twice (they concatenate id
-- sets with ||). Bodies otherwise verbatim from 20261023093900 (identical to
-- prod, md5 checked 2026-10-24).

-- 1 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ledger_period_account_days(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_exclude_ids uuid[]
)
RETURNS TABLE (
  account_number text,
  entry_date date,
  debit numeric,
  credit numeric,
  net_debit numeric,
  net_credit numeric,
  line_count integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT d.account_number, d.entry_date, d.debit, d.credit, d.net_debit, d.net_credit, d.line_count
  FROM public.ledger_account_days d
  WHERE d.company_id = p_company_id
    AND d.fiscal_period_id = p_fiscal_period_id
  UNION ALL
  SELECT l.account_number, e.entry_date,
         -coalesce(l.debit_amount, 0),
         -coalesce(l.credit_amount, 0),
         -greatest(l.debit_amount - l.credit_amount, 0),
         -greatest(l.credit_amount - l.debit_amount, 0),
         -1
  FROM (SELECT DISTINCT u.id FROM unnest(coalesce(p_exclude_ids, '{}'::uuid[])) AS u(id)) AS ex
  JOIN public.journal_entries e ON e.id = ex.id
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed')
$$;

REVOKE ALL ON FUNCTION public.ledger_period_account_days(uuid, uuid, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_period_account_days(uuid, uuid, uuid[]) TO authenticated, service_role;

-- 2 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ledger_period_dimension_days(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_dim_no text,
  p_code text,
  p_exclude_ids uuid[]
)
RETURNS TABLE (
  code text,
  account_number text,
  entry_date date,
  debit numeric,
  credit numeric,
  net_debit numeric,
  net_credit numeric,
  line_count integer
)
LANGUAGE sql
STABLE
AS $$
  SELECT d.code, d.account_number, d.entry_date, d.debit, d.credit, d.net_debit, d.net_credit, d.line_count
  FROM public.ledger_dimension_days d
  WHERE d.company_id = p_company_id
    AND d.fiscal_period_id = p_fiscal_period_id
    AND d.dim_no = p_dim_no
    AND (p_code IS NULL OR d.code = p_code)
  UNION ALL
  SELECT l.dimensions ->> p_dim_no, l.account_number, e.entry_date,
         -coalesce(l.debit_amount, 0),
         -coalesce(l.credit_amount, 0),
         -greatest(l.debit_amount - l.credit_amount, 0),
         -greatest(l.credit_amount - l.debit_amount, 0),
         -1
  FROM (SELECT DISTINCT u.id FROM unnest(coalesce(p_exclude_ids, '{}'::uuid[])) AS u(id)) AS ex
  JOIN public.journal_entries e ON e.id = ex.id
  JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed')
    AND jsonb_typeof(l.dimensions -> p_dim_no) = 'string'
    AND (p_code IS NULL OR l.dimensions ->> p_dim_no = p_code)
$$;

REVOKE ALL ON FUNCTION public.ledger_period_dimension_days(uuid, uuid, text, text, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ledger_period_dimension_days(uuid, uuid, text, text, uuid[]) TO authenticated, service_role;

-- 3 ---------------------------------------------------------------------------

-- The entries of a period that 'exclude-all-year-end' leaves out: every
-- year_end entry, every storno or rättelse of a reversed year_end entry
-- (company-wide: the chain can cross periods), and a resultatavslut booked
-- outside the year-end run (see the header). The one definition: the RPCs
-- below and fetchYearEndEntryIds in lib/reports/trial-balance.ts read it.
CREATE OR REPLACE FUNCTION public.year_end_chain_entry_ids(
  p_company_id uuid,
  p_fiscal_period_id uuid
)
RETURNS uuid[]
LANGUAGE plpgsql
STABLE
SET search_path TO ''
AS $$
DECLARE
  v_chain uuid[];
  v_candidates uuid[];
  v_closings uuid[];
BEGIN
  WITH ye_reversed AS (
    SELECT y.id
    FROM public.journal_entries y
    WHERE y.company_id = p_company_id
      AND y.source_type = 'year_end'
      AND y.status = 'reversed'
  )
  SELECT coalesce(array_agg(DISTINCT e.id), '{}'::uuid[])
    INTO v_chain
  FROM public.journal_entries e
  WHERE e.company_id = p_company_id
    AND e.fiscal_period_id = p_fiscal_period_id
    AND e.status IN ('posted', 'reversed')
    AND e.id IN (
      SELECT a.id FROM public.journal_entries a
      WHERE a.company_id = p_company_id AND a.source_type = 'year_end'
      UNION
      SELECT b.id FROM public.journal_entries b
      WHERE b.reverses_id IN (SELECT id FROM ye_reversed)
      UNION
      SELECT c.id FROM public.journal_entries c
      WHERE c.correction_of_id IN (SELECT id FROM ye_reversed)
    );

  -- A resultatavslut by shape that books a result account outside årets
  -- resultat. Usually none, and then the year's lines are never read.
  SELECT coalesce(array_agg(c.id), '{}'::uuid[])
    INTO v_candidates
  FROM unnest(public.result_closing_entry_ids(p_company_id, p_fiscal_period_id)) AS c(id)
  WHERE c.id <> ALL (v_chain)
    AND EXISTS (
      SELECT 1
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = c.id
        AND l.account_number >= '3'
        AND l.account_number < '8990'
    );

  IF cardinality(v_candidates) = 0 THEN
    RETURN v_chain;
  END IF;

  -- Kept only when every such account it books is at zero for the year.
  WITH touched AS (
    SELECT DISTINCT l.account_number
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = ANY (v_candidates)
      AND l.account_number >= '3'
      AND l.account_number < '8990'
  ),
  open_accounts AS (
    SELECT l.account_number
    FROM public.journal_entries e
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND l.account_number IN (SELECT t.account_number FROM touched t)
    GROUP BY l.account_number
    HAVING round(sum(coalesce(l.credit_amount, 0) - coalesce(l.debit_amount, 0)), 2) <> 0
  )
  SELECT coalesce(array_agg(c.id), '{}'::uuid[])
    INTO v_closings
  FROM unnest(v_candidates) AS c(id)
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.journal_entry_lines l
    WHERE l.journal_entry_id = c.id
      AND l.account_number IN (SELECT o.account_number FROM open_accounts o)
  );

  RETURN (
    SELECT coalesce(array_agg(DISTINCT x.id ORDER BY x.id), '{}'::uuid[])
    FROM unnest(v_chain || v_closings) AS x(id)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.year_end_chain_entry_ids(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.year_end_chain_entry_ids(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.year_end_chain_entry_ids(uuid, uuid) IS
  'Entries of the period that ''exclude-all-year-end'' leaves out: year_end entries, the storno/rättelse chain of a reversed one, and a resultatavslut booked outside the year-end run that zeroes the result accounts (outside 8990-8999) it books.';

-- 4 ---------------------------------------------------------------------------

-- get_trial_balance_aggregates: body of 20261023093900 except that
-- 'exclude-all-year-end' reads year_end_chain_entry_ids once, on both paths.
CREATE OR REPLACE FUNCTION public.get_trial_balance_aggregates(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_closing_mode text,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL,
  p_exclude_entry_id uuid DEFAULT NULL,
  p_dimensions jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
SET work_mem TO '32MB'
AS $$
DECLARE
  v_period_start date;
  v_closing_entry_id uuid;
  v_is_closed boolean;
  v_closed_externally boolean;
  v_exclude_closing_ids uuid[] := '{}'::uuid[];
  v_year_end_ids uuid[] := '{}'::uuid[];
  v_roll_start date := NULL;
  v_exclude_ids uuid[];
  v_dim_no text;
  v_code text;
  v_summary boolean := false;
BEGIN
  IF p_closing_mode IS NULL
     OR p_closing_mode NOT IN ('include', 'exclude-final', 'exclude-all-year-end') THEN
    RAISE EXCEPTION 'get_trial_balance_aggregates: unknown closing mode %', p_closing_mode
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT fp.period_start, fp.closing_entry_id, fp.is_closed, fp.closed_externally
    INTO v_period_start, v_closing_entry_id, v_is_closed, v_closed_externally
  FROM public.fiscal_periods fp
  WHERE fp.id = p_fiscal_period_id
    AND fp.company_id = p_company_id;

  IF p_closing_mode = 'exclude-final' THEN
    IF v_is_closed IS TRUE
       AND v_closing_entry_id IS NULL
       AND v_closed_externally IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'Closed fiscal period is missing closing_entry_id; statutory pre-closing balances cannot be generated safely'
        USING ERRCODE = 'check_violation';
    END IF;
    -- Posted entries only, so a reversed closing stays with its storno.
    v_exclude_closing_ids := public.result_closing_entry_ids(p_company_id, p_fiscal_period_id);
  END IF;

  IF p_closing_mode = 'exclude-all-year-end' THEN
    v_year_end_ids := public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id);
  END IF;

  IF p_from_date IS NOT NULL
     AND v_period_start IS NOT NULL
     AND p_from_date > v_period_start THEN
    v_roll_start := v_period_start;
  END IF;

  -- The summaries answer no filter and a filter on one string value; a
  -- filter on several values (a line must carry all of them) needs the lines.
  IF public.ledger_account_days_ready(p_company_id) THEN
    IF p_dimensions IS NULL THEN
      v_summary := true;
    ELSIF jsonb_typeof(p_dimensions) = 'object' THEN
      IF NOT EXISTS (SELECT 1 FROM jsonb_object_keys(p_dimensions)) THEN
        v_summary := true;
      ELSIF (SELECT count(*) FROM jsonb_object_keys(p_dimensions)) = 1 THEN
        SELECT d.key, d.value #>> '{}' INTO v_dim_no, v_code
        FROM jsonb_each(p_dimensions) d
        WHERE jsonb_typeof(d.value) = 'string';
        v_summary := v_dim_no IS NOT NULL;
      END IF;
    END IF;
  END IF;

  IF v_summary THEN
    v_exclude_ids := v_exclude_closing_ids
      || CASE WHEN p_exclude_entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_exclude_entry_id] END
      || v_year_end_ids;

    RETURN (
      SELECT COALESCE(
        jsonb_agg(
          jsonb_build_object(
            'bucket', t.bucket,
            'account_number', t.account_number,
            'debit', t.debit,
            'credit', t.credit
          )
          ORDER BY t.bucket, t.account_number
        ),
        '[]'::jsonb
      )
      FROM (
        SELECT b.bucket, b.account_number, sum(b.debit) AS debit, sum(b.credit) AS credit
        FROM (
          SELECT CASE
                   WHEN v_roll_start IS NOT NULL
                        AND d.entry_date >= v_roll_start
                        AND d.entry_date < p_from_date
                     THEN 'rollforward'
                   WHEN (p_from_date IS NULL OR d.entry_date >= p_from_date)
                        AND (p_to_date IS NULL OR d.entry_date <= p_to_date)
                     THEN 'period'
                   ELSE NULL
                 END AS bucket,
                 d.account_number, d.debit, d.credit, d.line_count
          FROM (
            SELECT a.account_number, a.entry_date, a.debit, a.credit, a.line_count
            FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_exclude_ids) a
            WHERE v_dim_no IS NULL
            UNION ALL
            SELECT m.account_number, m.entry_date, m.debit, m.credit, m.line_count
            FROM public.ledger_period_dimension_days(p_company_id, p_fiscal_period_id, v_dim_no, v_code, v_exclude_ids) m
            WHERE v_dim_no IS NOT NULL
          ) d
        ) b
        WHERE b.bucket IS NOT NULL
        GROUP BY b.bucket, b.account_number
        HAVING sum(b.line_count) > 0
      ) t
    );
  END IF;

  RETURN (
  WITH entries AS (
    SELECT e.id, e.entry_date
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND (p_exclude_entry_id IS NULL OR e.id <> p_exclude_entry_id)
      AND e.id <> ALL (v_year_end_ids)
      AND e.id <> ALL (v_exclude_closing_ids)
  ),
  bucketed AS (
    SELECT e.id,
           CASE
             WHEN v_roll_start IS NOT NULL
                  AND e.entry_date >= v_roll_start
                  AND e.entry_date < p_from_date
               THEN 'rollforward'
             WHEN (p_from_date IS NULL OR e.entry_date >= p_from_date)
                  AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
               THEN 'period'
             ELSE NULL
           END AS bucket
    FROM entries e
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'bucket', t.bucket,
        'account_number', t.account_number,
        'debit', t.debit,
        'credit', t.credit
      )
      ORDER BY t.bucket, t.account_number
    ),
    '[]'::jsonb
  )
  FROM (
    SELECT b.bucket,
           l.account_number,
           sum(l.debit_amount) AS debit,
           sum(l.credit_amount) AS credit
    FROM public.journal_entry_lines l
    JOIN bucketed b ON b.id = l.journal_entry_id
    WHERE b.bucket IS NOT NULL
      AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
    GROUP BY b.bucket, l.account_number
  ) t
  );
END;
$$;

COMMENT ON FUNCTION public.get_trial_balance_aggregates(uuid, uuid, text, date, date, uuid, jsonb) IS
  'Per-account debit/credit sums for a fiscal period (period + rollforward buckets) under one ClosingEntryMode; the SQL side of generateTrialBalance. Issue #2470. exclude-final drops result_closing_entry_ids, exclude-all-year-end drops year_end_chain_entry_ids. Reads ledger_account_days / ledger_dimension_days once the company is built and the filter is at most one dimension value.';

-- 5 ---------------------------------------------------------------------------

-- get_kpi_report_aggregates: body of 20261023093900 except that the year-end
-- set is year_end_chain_entry_ids, read once, on both paths.
CREATE OR REPLACE FUNCTION public.get_kpi_report_aggregates(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_ob_entry_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_ob uuid[] := CASE WHEN p_ob_entry_id IS NULL THEN '{}'::uuid[] ELSE ARRAY[p_ob_entry_id] END;
  v_year_end uuid[] := public.year_end_chain_entry_ids(p_company_id, p_fiscal_period_id);
  v_ob_and_year_end uuid[];
BEGIN
  IF public.ledger_account_days_ready(p_company_id) THEN
    v_ob_and_year_end := v_ob || v_year_end;

    RETURN (
      WITH tb AS (
        SELECT d.account_number, sum(d.debit) AS debit, sum(d.credit) AS credit
        FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_ob) d
        GROUP BY d.account_number
        HAVING sum(d.line_count) > 0
      ),
      ex_year_end AS (
        SELECT d.account_number, d.entry_date, d.debit, d.credit, d.net_debit, d.net_credit, d.line_count
        FROM public.ledger_period_account_days(p_company_id, p_fiscal_period_id, v_ob_and_year_end) d
      ),
      tb_ex_year_end AS (
        SELECT x.account_number, sum(x.debit) AS debit, sum(x.credit) AS credit
        FROM ex_year_end x
        GROUP BY x.account_number
        HAVING sum(x.line_count) > 0
      ),
      monthly AS (
        -- Per line: class 3 credit - debit, class 4-7 debit - credit, class 8
        -- (not årets resultat, 8990-8999) by its own sign; net_credit -
        -- net_debit is the line
        -- difference with NULL differences left out, as the line query sums.
        SELECT EXTRACT(YEAR FROM x.entry_date)::int AS year,
               EXTRACT(MONTH FROM x.entry_date)::int AS month,
               (
                 COALESCE(sum(x.net_credit - x.net_debit) FILTER (WHERE x.account_number ~ '^3'), 0)
                 + COALESCE(sum(x.net_credit) FILTER (WHERE x.account_number ~ '^8' AND x.account_number NOT BETWEEN '8990' AND '8999'), 0)
               )::float8 AS income,
               (
                 COALESCE(sum(x.net_debit - x.net_credit) FILTER (WHERE x.account_number ~ '^[4-7]'), 0)
                 + COALESCE(sum(x.net_debit) FILTER (WHERE x.account_number ~ '^8' AND x.account_number NOT BETWEEN '8990' AND '8999'), 0)
               )::float8 AS expenses
        FROM ex_year_end x
        WHERE x.account_number ~ '^[3-8]'
        GROUP BY 1, 2
        HAVING sum(x.line_count) > 0
      )
      SELECT jsonb_build_object(
        'tb', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'account_number', t.account_number,
            'debit', t.debit::float8,
            'credit', t.credit::float8
          ) ORDER BY t.account_number)
          FROM tb t
        ), '[]'::jsonb),
        'tb_ex_year_end', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'account_number', t.account_number,
            'debit', t.debit::float8,
            'credit', t.credit::float8
          ) ORDER BY t.account_number)
          FROM tb_ex_year_end t
        ), '[]'::jsonb),
        'ob', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'account_number', t.account_number,
            'debit', t.debit,
            'credit', t.credit
          ) ORDER BY t.account_number)
          FROM (
            -- No status filter: getOpeningBalances only checks id + company_id.
            SELECT l.account_number,
                   sum(l.debit_amount)::float8 AS debit,
                   sum(l.credit_amount)::float8 AS credit
            FROM public.journal_entry_lines l
            JOIN public.journal_entries e
              ON e.id = l.journal_entry_id
             AND e.id = p_ob_entry_id
             AND e.company_id = p_company_id
            GROUP BY l.account_number
          ) t
        ), '[]'::jsonb),
        'monthly', COALESCE((
          SELECT jsonb_agg(jsonb_build_object(
            'year', m.year,
            'month', m.month,
            'income', m.income,
            'expenses', m.expenses
          ) ORDER BY m.year, m.month)
          FROM monthly m
        ), '[]'::jsonb)
      )
    );
  END IF;

  RETURN (
WITH period_entries AS (
  SELECT id, entry_date, status, source_type, reverses_id, correction_of_id
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status IN ('posted', 'reversed')
),
tb_entries AS (
  SELECT * FROM period_entries
  WHERE p_ob_entry_id IS NULL OR id <> p_ob_entry_id
),
tb_ex_ye_entries AS (
  SELECT * FROM tb_entries
  WHERE id <> ALL (v_year_end)
)
SELECT jsonb_build_object(
  'tb', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN tb_entries e ON e.id = l.journal_entry_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'tb_ex_year_end', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN tb_ex_ye_entries e ON e.id = l.journal_entry_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'ob', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'account_number', t.account_number,
      'debit', t.debit,
      'credit', t.credit
    ) ORDER BY t.account_number)
    FROM (
      -- No status filter: getOpeningBalances only checks id + company_id.
      SELECT l.account_number,
             sum(l.debit_amount)::float8 AS debit,
             sum(l.credit_amount)::float8 AS credit
      FROM public.journal_entry_lines l
      JOIN public.journal_entries e
        ON e.id = l.journal_entry_id
       AND e.id = p_ob_entry_id
       AND e.company_id = p_company_id
      GROUP BY l.account_number
    ) t
  ), '[]'::jsonb),
  'monthly', COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'year', m.year,
      'month', m.month,
      'income', m.income,
      'expenses', m.expenses
    ) ORDER BY m.year, m.month)
    FROM (
      SELECT EXTRACT(YEAR FROM e.entry_date)::int AS year,
             EXTRACT(MONTH FROM e.entry_date)::int AS month,
             (
               COALESCE(sum(CASE
                 WHEN l.account_number ~ '^3'
                 THEN l.credit_amount - l.debit_amount
               END), 0)
               + COALESCE(sum(CASE
                 WHEN l.account_number ~ '^8'
                  AND l.account_number NOT BETWEEN '8990' AND '8999'
                  AND (l.credit_amount - l.debit_amount) >= 0
                 THEN l.credit_amount - l.debit_amount
               END), 0)
             )::float8 AS income,
             (
               COALESCE(sum(CASE
                 WHEN l.account_number ~ '^[4-7]'
                 THEN l.debit_amount - l.credit_amount
               END), 0)
               + COALESCE(sum(CASE
                 WHEN l.account_number ~ '^8'
                  AND l.account_number NOT BETWEEN '8990' AND '8999'
                  AND (l.credit_amount - l.debit_amount) < 0
                 THEN l.debit_amount - l.credit_amount
               END), 0)
             )::float8 AS expenses
      FROM public.journal_entry_lines l
      -- The same entry set as tb_ex_year_end, with NO extra status predicate:
      -- posted AND reversed originals, minus the year-end set. A reversed
      -- original and its storno then cancel within the year exactly as they
      -- do in the year total, so sum(months) = Nettoresultat. Matches
      -- lib/reports/monthly-breakdown.ts.
      JOIN tb_ex_ye_entries e
        ON e.id = l.journal_entry_id
      WHERE l.account_number ~ '^[3-8]'
      GROUP BY 1, 2
    ) m
  ), '[]'::jsonb)
)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) TO authenticated, service_role;
