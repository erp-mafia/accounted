-- result_closing_entry_ids: one definition of "the entries that moved this
-- year's result into equity", and get_trial_balance_aggregates' 'exclude-final'
-- mode rebuilt on it.
--
-- 'exclude-final' is the statutory pre-closing view (årsredovisning, iXBRL,
-- INK2R, NE-bilaga): the income statement must be read BEFORE the
-- resultatavslut zeroes every result account into årets resultat. It used to
-- recognise that entry only by fiscal_periods.closing_entry_id, a link that
-- only Accounted's own year-end run sets. A year whose resultatavslut was
-- booked in the previous system (SIE-imported, source_type 'import') or by
-- hand ('manual') has no link, so nothing was stripped and its income
-- statement read 0 kr on every row, while the balance sheet (which includes
-- the entry) stayed right. It surfaced as an all-zero comparative year in the
-- next year's årsredovisning.
--
-- The set returned here is:
--   - fiscal_periods.closing_entry_id while it is posted (unchanged), and
--   - every other posted entry of the period that is a result transfer by
--     shape: dated on the period's last day, not a storno, every line on a
--     result account (BAS class 3-8) or on the årets resultat equity account
--     (2099 aktiebolag, 2019 enskild firma, 2069 ideell förening), with at
--     least one line on each side. Nothing else books result accounts
--     straight against årets resultat: that is what a resultatavslut is.
--     Reading the resultaträkning with such an entry left out is what makes
--     its result equal the booked 2099.
--
-- Deliberately NOT matched:
--   - entries that only move amounts between result accounts, 8999 included
--     (öresutjämning or corrections booked against 8999): they carry no line
--     on the equity account, and prod holds real activity booked that way;
--   - 2010 Eget kapital: an enskild firma books private payments of
--     business costs there, so a result line against 2010 is not a closing;
--   - stornos (reverses_id set) and reversed entries: a reversed closing
--     keeps netting to zero against its storno, as before.
--
-- SECURITY INVOKER and STABLE, like the RPC: RLS applies to the caller. The
-- explicit company_id predicates are defence in depth for service-role
-- callers. Returns uuid[] rather than a row set (no PostgREST max-rows cap).

CREATE OR REPLACE FUNCTION public.result_closing_entry_ids(
  p_company_id uuid,
  p_fiscal_period_id uuid
)
RETURNS uuid[]
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path TO 'public'
AS $$
  SELECT COALESCE(array_agg(x.id ORDER BY x.id), '{}'::uuid[])
  FROM (
    SELECT e.id
    FROM public.fiscal_periods fp
    JOIN public.journal_entries e ON e.id = fp.closing_entry_id
    WHERE fp.id = p_fiscal_period_id
      AND fp.company_id = p_company_id
      AND e.company_id = p_company_id
      AND e.status = 'posted'
    UNION
    SELECT e.id
    FROM public.fiscal_periods fp
    JOIN public.journal_entries e
      ON e.fiscal_period_id = fp.id
     AND e.company_id = fp.company_id
     AND e.entry_date = fp.period_end
    JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
    WHERE fp.id = p_fiscal_period_id
      AND fp.company_id = p_company_id
      AND e.status = 'posted'
      AND e.reverses_id IS NULL
    GROUP BY e.id
    HAVING bool_and(
             (l.account_number >= '3' AND l.account_number < '9')
             OR l.account_number IN ('2099', '2019', '2069')
           )
       AND bool_or(l.account_number IN ('2099', '2019', '2069'))
       AND bool_or(l.account_number >= '3' AND l.account_number < '9')
  ) x;
$$;

REVOKE ALL ON FUNCTION public.result_closing_entry_ids(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.result_closing_entry_ids(uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.result_closing_entry_ids(uuid, uuid) IS
  'Posted entries that moved the period''s result into equity: the linked closing entry plus any resultatavslut booked elsewhere (last day, result accounts against 2099/2019/2069 only). The set ''exclude-final'' drops.';

-- get_trial_balance_aggregates: body of migration 20260910163731 unchanged
-- except that 'exclude-final' drops every id of result_closing_entry_ids
-- instead of closing_entry_id alone. The fail-closed guard for a closed
-- period without the link (and not closed_externally) stays as it was.

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
SECURITY INVOKER
SET search_path TO 'public'
SET work_mem TO '32MB'
AS $$
DECLARE
  v_period_start date;
  v_closing_entry_id uuid;
  v_is_closed boolean;
  v_closed_externally boolean;
  v_exclude_closing_ids uuid[] := '{}'::uuid[];
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
    -- Posted entries only, so a reversed closing stays with its storno.
    v_exclude_closing_ids := public.result_closing_entry_ids(p_company_id, p_fiscal_period_id);
  END IF;

  IF p_from_date IS NOT NULL
     AND v_period_start IS NOT NULL
     AND p_from_date > v_period_start THEN
    v_roll_start := v_period_start;
  END IF;

  RETURN (
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
  'Per-account debit/credit sums for a fiscal period (period + rollforward buckets) under one ClosingEntryMode; the SQL side of generateTrialBalance. Issue #2470. exclude-final drops result_closing_entry_ids.';

NOTIFY pgrst, 'reload schema';
