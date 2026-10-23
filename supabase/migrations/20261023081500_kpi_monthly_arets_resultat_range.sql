-- get_kpi_report_aggregates: årets resultat is BAS 8990-8999 in the monthly
-- breakdown, as everywhere else.
--
-- The monthly buckets left out only 8999 (Årets resultat). A previous system
-- that moves the year's result to equity through 8990 (Resultat) instead put
-- that omföring into the closing month: the month showed the whole year's
-- result as an expense (or income) and the year summed to 0 kr, while BAS,
-- the årsredovisning (k2-mapper), the NE-bilaga and the result guards all
-- read 8990-8999 as årets resultat. The 2026-10-23 reconciliation found 13
-- imported omföringar through 8990 in 7 companies.
--
-- lib/reports/monthly-breakdown.ts (the JS path serving the same chart with a
-- dimension filter) moves to the same predicate in the same change, through
-- isAretsResultatAccount (lib/bookkeeping/bas-data/result-accounts.ts), so
-- the two paths keep agreeing. Everything else is byte-identical to
-- 20260903160000 (its body matched prod's on 2026-10-23).

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
      -- posted AND reversed originals, minus the undone year-end chain. A
      -- reversed original and its storno then cancel within the year exactly
      -- as they do in the year total, so sum(months) = Nettoresultat. Matches
      -- lib/reports/monthly-breakdown.ts.
      JOIN tb_ex_ye_entries e
        ON e.id = l.journal_entry_id
      WHERE l.account_number ~ '^[3-8]'
      GROUP BY 1, 2
    ) m
  ), '[]'::jsonb)
)
$$;

REVOKE ALL ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kpi_report_aggregates(uuid, uuid, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
