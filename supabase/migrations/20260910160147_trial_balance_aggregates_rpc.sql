-- get_trial_balance_aggregates: per-account debit/credit sums for one fiscal
-- period, aggregated in SQL instead of walking every journal line through
-- PostgREST (issue #2470).
--
-- generateTrialBalance (lib/reports/trial-balance.ts) is the single function
-- behind the balance sheet, resultatrapport, INK2, NE-bilaga, årsredovisning,
-- the year-end engine, MCP and the v1 API. It used to fetch every line of the
-- period in 100-entry chunks and sum in JS: seconds and dozens of round trips
-- on a 25 000-line period. This RPC returns the same sums in one round trip.
--
-- Semantics are a verbatim port of the two fetchEntryLines passes in
-- generateTrialBalance. Nothing here is new accounting logic:
--
--   base set      company + fiscal period, status IN ('posted','reversed'),
--                 minus p_exclude_entry_id (the opening-balance entry, whose
--                 values already sit in IB)
--   'include'     the base set as is (balance sheets, year-end engine)
--   'exclude-final'
--                 additionally drop fiscal_periods.closing_entry_id while it
--                 is POSTED; a reversed closing entry stays together with its
--                 storno so the pair keeps netting to zero (same predicate as
--                 get_vat_declaration_totals). A closed period with no
--                 closing_entry_id that was not closed_externally raises the
--                 same error the JS guard throws: a statutory report must not
--                 silently understate.
--   'exclude-all-year-end'
--                 drop every source_type 'year_end' entry plus the stornos and
--                 corrections of REVERSED year-end entries, company-wide
--                 (same predicate as get_kpi_report_aggregates'
--                 tb_ex_year_end). journal_entries.source_type is NOT NULL,
--                 so IS DISTINCT FROM and <> agree.
--   buckets       'period' is [p_from_date, p_to_date] (either bound
--                 optional); 'rollforward' is [period_start, p_from_date)
--                 and exists only when p_from_date lies after period_start,
--                 so the caller can fold it into IB.
--   p_dimensions  jsonb containment on the line (dimensions @> p_dimensions),
--                 served by idx_jel_dimensions_gin. NULL means no filter.
--
-- SECURITY INVOKER: RLS on journal_entries / journal_entry_lines /
-- fiscal_periods applies exactly as it does to the PostgREST path. The
-- explicit company_id predicates are defence in depth for service-role
-- callers. work_mem is raised for the call so the GROUP BY sorts in memory on
-- the largest periods.

CREATE OR REPLACE FUNCTION public.get_trial_balance_aggregates(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_closing_mode text,
  p_from_date date DEFAULT NULL,
  p_to_date date DEFAULT NULL,
  p_exclude_entry_id uuid DEFAULT NULL,
  p_dimensions jsonb DEFAULT NULL
)
RETURNS TABLE (
  bucket text,
  account_number text,
  debit numeric,
  credit numeric
)
LANGUAGE plpgsql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
SET work_mem TO '32MB'
AS $$
DECLARE
  v_period_start date;
  v_closing_entry_id uuid;
  v_is_closed boolean;
  v_closed_externally boolean;
  v_exclude_closing_id uuid := NULL;
  v_roll_start date := NULL;
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
    v_exclude_closing_id := v_closing_entry_id;
  END IF;

  IF p_from_date IS NOT NULL
     AND v_period_start IS NOT NULL
     AND p_from_date > v_period_start THEN
    v_roll_start := v_period_start;
  END IF;

  RETURN QUERY
  WITH ye_reversed AS (
    -- Company-wide, no period filter: a storno in this period can reverse a
    -- year-end entry from another period (mirrors the wave-1 fetch in
    -- lib/reports/trial-balance.ts).
    SELECT e.id
    FROM public.journal_entries e
    WHERE p_closing_mode = 'exclude-all-year-end'
      AND e.company_id = p_company_id
      AND e.source_type = 'year_end'
      AND e.status = 'reversed'
  ),
  entries AS (
    SELECT e.id, e.entry_date
    FROM public.journal_entries e
    WHERE e.company_id = p_company_id
      AND e.fiscal_period_id = p_fiscal_period_id
      AND e.status IN ('posted', 'reversed')
      AND (p_exclude_entry_id IS NULL OR e.id <> p_exclude_entry_id)
      AND (
        p_closing_mode <> 'exclude-all-year-end'
        OR (
          e.source_type IS DISTINCT FROM 'year_end'
          AND (e.reverses_id IS NULL
               OR e.reverses_id NOT IN (SELECT y.id FROM ye_reversed y))
          AND (e.correction_of_id IS NULL
               OR e.correction_of_id NOT IN (SELECT y.id FROM ye_reversed y))
        )
      )
      AND (
        v_exclude_closing_id IS NULL
        OR NOT (e.status = 'posted' AND e.id = v_exclude_closing_id)
      )
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
  SELECT b.bucket,
         l.account_number,
         sum(l.debit_amount) AS debit,
         sum(l.credit_amount) AS credit
  FROM public.journal_entry_lines l
  JOIN bucketed b ON b.id = l.journal_entry_id
  WHERE b.bucket IS NOT NULL
    AND (p_dimensions IS NULL OR l.dimensions @> p_dimensions)
  GROUP BY b.bucket, l.account_number
  ORDER BY b.bucket, l.account_number;
END;
$$;

REVOKE ALL ON FUNCTION public.get_trial_balance_aggregates(uuid, uuid, text, date, date, uuid, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_trial_balance_aggregates(uuid, uuid, text, date, date, uuid, jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_trial_balance_aggregates(uuid, uuid, text, date, date, uuid, jsonb) IS
  'Per-account debit/credit sums for a fiscal period (period + rollforward buckets) under one ClosingEntryMode; the SQL side of generateTrialBalance. Issue #2470.';

NOTIFY pgrst, 'reload schema';
