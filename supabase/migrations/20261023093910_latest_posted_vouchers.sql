-- latest_posted_vouchers: the highest posted voucher number per series in a
-- report window, read with a few index probes instead of every verifikat.
--
-- The resultatrapport and balansrapport headers print "senaste verifikat"
-- per series (getLatestPostedVouchers, lib/reports/latest-vouchers.ts). It
-- paged every posted verifikat of the period through PostgREST, 1 000 at a
-- time, to take a max in TypeScript: 51 sequential round trips and ~2.3 s for
-- a year of 50 000 verifikat, more than the rest of either report.
--
-- Same set as before: the period's posted and reversed entries with a number
-- (drafts and cancelled entries carry 0), entry_date in [p_from_date,
-- p_to_date] (no lower bound when p_from_date is NULL), max per series, an
-- empty or NULL series counted as 'A'. The series are walked with the
-- partial unique index uq_journal_entries_voucher_number (company_id,
-- fiscal_period_id, voucher_series, voucher_number) WHERE voucher_number > 0,
-- and each series' max is a backward scan of the same index that stops at the
-- first entry inside the window.
--
-- SECURITY INVOKER: RLS applies to the caller; the company_id predicates are
-- defence in depth for service-role callers.

CREATE OR REPLACE FUNCTION public.latest_posted_vouchers(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_from_date date,
  p_to_date date
)
RETURNS TABLE (voucher_series text, last_number integer)
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  WITH RECURSIVE series AS (
    (
      SELECT e.voucher_series AS s
      FROM public.journal_entries e
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.voucher_number > 0
        AND e.voucher_series IS NOT NULL
      ORDER BY e.voucher_series
      LIMIT 1
    )
    UNION ALL
    SELECT (
      SELECT e.voucher_series
      FROM public.journal_entries e
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.voucher_number > 0
        AND e.voucher_series > series.s
      ORDER BY e.voucher_series
      LIMIT 1
    )
    FROM series
    WHERE series.s IS NOT NULL
  ),
  latest AS (
    SELECT series.s AS series_name, (
      SELECT e.voucher_number
      FROM public.journal_entries e
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.voucher_series = series.s
        AND e.voucher_number > 0
        AND e.status IN ('posted', 'reversed')
        AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
        AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
      ORDER BY e.voucher_number DESC
      LIMIT 1
    ) AS n
    FROM series
    WHERE series.s IS NOT NULL
    UNION ALL
    SELECT NULL, (
      SELECT e.voucher_number
      FROM public.journal_entries e
      WHERE e.company_id = p_company_id
        AND e.fiscal_period_id = p_fiscal_period_id
        AND e.voucher_series IS NULL
        AND e.voucher_number > 0
        AND e.status IN ('posted', 'reversed')
        AND (p_to_date IS NULL OR e.entry_date <= p_to_date)
        AND (p_from_date IS NULL OR e.entry_date >= p_from_date)
      ORDER BY e.voucher_number DESC
      LIMIT 1
    )
  )
  SELECT coalesce(nullif(l.series_name, ''), 'A'), max(l.n)
  FROM latest l
  WHERE l.n IS NOT NULL
  GROUP BY 1
$$;

REVOKE ALL ON FUNCTION public.latest_posted_vouchers(uuid, uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.latest_posted_vouchers(uuid, uuid, date, date) TO authenticated, service_role;

COMMENT ON FUNCTION public.latest_posted_vouchers(uuid, uuid, date, date) IS
  'Highest posted/reversed voucher number per series (empty or NULL as A) of a fiscal period inside [p_from_date, p_to_date]; the SQL side of getLatestPostedVouchers.';

NOTIFY pgrst, 'reload schema';
