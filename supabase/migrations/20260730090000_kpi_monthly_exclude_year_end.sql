-- get_kpi_report_aggregates: keep the resultatavslut out of the monthly chart.
--
-- The 'monthly' section joined period_entries, i.e. EVERY posted entry in the
-- fiscal period. The closing verifikat posts the mirror image of every P&L
-- account, so once a year was closed the fiscal-year-end month reported the
-- whole year's revenue as negative income on the KPI chart.
--
-- Measured on production before this change: 28 companies affected across 34
-- month-rows, worst case a single month's income understated by 10 347 472 kr.
--
-- 20260723180000 documented the omission as deliberate ("year_end entries are
-- NOT excluded here: the JS scan never excluded them either"). That mirrored
-- lib/reports/monthly-breakdown.ts faithfully, but the JS scan was itself
-- wrong; both are corrected together so the RPC path and the dimension-filtered
-- fallback keep agreeing.
--
-- tb_ex_ye_entries already exists in this function for the tb_ex_year_end
-- section, so the fix reuses it rather than inventing a third convention: it
-- drops source_type year_end plus the stornos and corrections of REVERSED
-- year-end entries (the undone-year-end chain).

CREATE OR REPLACE FUNCTION public.get_kpi_report_aggregates(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_ob_entry_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
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
ye_reversed AS (
  -- Company-wide (no period filter), mirroring the wave-1 fetch in
  -- lib/reports/trial-balance.ts: a storno in this period can reverse a
  -- year-end entry from another period.
  SELECT id
  FROM public.journal_entries
  WHERE company_id = p_company_id
    AND source_type = 'year_end'
    AND status = 'reversed'
),
tb_ex_ye_entries AS (
  SELECT * FROM tb_entries
  WHERE source_type IS DISTINCT FROM 'year_end'
    AND (reverses_id IS NULL
         OR reverses_id NOT IN (SELECT id FROM ye_reversed))
    AND (correction_of_id IS NULL
         OR correction_of_id NOT IN (SELECT id FROM ye_reversed))
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
                  AND l.account_number <> '8999'
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
                  AND l.account_number <> '8999'
                  AND (l.credit_amount - l.debit_amount) < 0
                 THEN l.debit_amount - l.credit_amount
               END), 0)
             )::float8 AS expenses
      FROM public.journal_entry_lines l
      -- Previously joined every posted entry in the period. The resultatavslut
      -- posts the mirror image of every P&L account, so the fiscal-year-end
      -- month showed the whole year's revenue as NEGATIVE income. Joining the
      -- year-end-excluded set instead keeps the chart on operating activity,
      -- and matches lib/reports/monthly-breakdown.ts.
      JOIN tb_ex_ye_entries e
        ON e.id = l.journal_entry_id
       AND e.status = 'posted'
      WHERE l.account_number ~ '^[3-8]'
      GROUP BY 1, 2
    ) m
  ), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
