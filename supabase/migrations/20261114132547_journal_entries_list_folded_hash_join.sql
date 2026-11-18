-- Verifikationslista: the correction fold is one hash join, not a lookup per row.
--
-- 20261112100013 made the list carry keys through its count and sort. For a
-- company with a very large open year a page was still almost twice as slow
-- as the same query run with its values written in. The difference is the
-- correction fold. Inside the function the parameters are not known when the
-- query is planned, and the fold was written as
-- `NOT p_collapse_corrections OR NOT EXISTS (...)`: an EXISTS under an OR
-- cannot become a join, so Postgres ran the subquery once per verifikat, one
-- index lookup each (read from the plan with
-- plan_cache_mode = force_generic_plan).
--
-- Now the posted corrections of the company are collected once (`folded`,
-- empty when the caller does not collapse) and the list anti-joins against
-- that set, which Postgres runs as one hash join whatever the parameters.
-- The same generic plan takes about a third less time.
--
-- Same rows. `p_collapse_corrections IS NOT FALSE` keeps the old meaning for
-- all three values: false folds nothing; true folds what it folded; NULL
-- also folded a corrected row before (`NULL OR false` filters it out) and
-- still does. A correction with no correction_of_id never matched a row and
-- is left out of the set.
--
-- Same 12-arg signature, so CREATE OR REPLACE keeps the existing GRANTs.

CREATE OR REPLACE FUNCTION public.list_fiscal_period_entries_with_related(
  p_company_id uuid,
  p_period_id uuid,
  p_include_related boolean DEFAULT true,
  p_status text DEFAULT NULL,
  p_date_from date DEFAULT NULL,
  p_date_to date DEFAULT NULL,
  p_sort_date text DEFAULT 'desc',
  p_limit int DEFAULT 50,
  p_offset int DEFAULT 0,
  p_exclude_draft boolean DEFAULT false,
  p_collapse_corrections boolean DEFAULT false,
  p_series text DEFAULT NULL
)
RETURNS TABLE (
  entry jsonb,
  total_count bigint
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
  WITH period AS (
    SELECT period_start, period_end
    FROM public.fiscal_periods
    WHERE id = p_period_id AND company_id = p_company_id
  ),
  -- The originals a posted correction has replaced: the correction fold
  -- below. Collected once, so the fold is a hash anti-join; empty when the
  -- caller does not collapse.
  folded AS MATERIALIZED (
    SELECT x.correction_of_id AS id
    FROM public.journal_entries x
    WHERE p_collapse_corrections IS NOT FALSE
      AND x.company_id = p_company_id
      AND x.source_type = 'correction'
      AND x.status = 'posted'
      AND x.correction_of_id IS NOT NULL
  ),
  candidates AS (
    -- The year's own verifikat.
    SELECT je.id, je.entry_date, je.voucher_series, je.voucher_number,
           je.status, je.source_type, je.reverses_id
    FROM public.journal_entries je
    CROSS JOIN period p
    WHERE je.company_id = p_company_id
      AND je.fiscal_period_id = p_period_id
    UNION ALL
    -- Payments and credit notes booked in another year for an invoice of
    -- this one.
    SELECT je.id, je.entry_date, je.voucher_series, je.voucher_number,
           je.status, je.source_type, je.reverses_id
    FROM public.journal_entries je
    CROSS JOIN period p
    WHERE p_include_related
      AND je.company_id = p_company_id
      AND je.fiscal_period_id <> p_period_id
      AND (
        (
          je.source_type IN ('invoice_paid','invoice_cash_payment','credit_note')
          AND EXISTS (
            SELECT 1 FROM public.invoices i
            WHERE i.id = je.source_id
              AND i.company_id = p_company_id
              AND i.invoice_date BETWEEN p.period_start AND p.period_end
          )
        )
        OR (
          je.source_type IN ('supplier_invoice_paid','supplier_invoice_cash_payment','supplier_credit_note')
          AND EXISTS (
            SELECT 1 FROM public.supplier_invoices si
            WHERE si.id = je.source_id
              AND si.company_id = p_company_id
              AND si.invoice_date BETWEEN p.period_start AND p.period_end
          )
        )
      )
  ),
  -- Read twice below (the total and the page), so it is computed once.
  matching AS MATERIALIZED (
    SELECT c.id, c.entry_date, c.voucher_series, c.voucher_number
    FROM candidates c
    WHERE (p_status IS NULL OR c.status = p_status)
      -- Hide cancelled by default; show them only when caller asks explicitly.
      AND (c.status <> 'cancelled' OR p_status = 'cancelled')
      -- Voucher-series filter (single letter A-Z). Applied before the count
      -- so total_count reflects the filtered set: this is the #798 fix.
      AND (p_series IS NULL OR c.voucher_series = p_series)
      -- Drafts live on their own surface; exclude them only on the committed
      -- list. Ignored when the caller asked for an explicit status (so a
      -- status='draft' request is never self-cancelled), mirroring the route's
      -- direct-query path.
      AND (NOT p_exclude_draft OR p_status IS NOT NULL OR c.status <> 'draft')
      -- Collapse a correction group to the live correction: fold the reversed
      -- original and its storno once a posted correction has replaced them.
      -- A storno with no correction stays visible: it is the only row that
      -- carries its voucher number (#3149).
      AND NOT EXISTS (
        SELECT 1 FROM folded f
        WHERE f.id = CASE
          WHEN c.source_type = 'storno' THEN c.reverses_id
          ELSE c.id
        END
      )
      AND (p_date_from IS NULL OR c.entry_date >= p_date_from)
      AND (p_date_to IS NULL OR c.entry_date <= p_date_to)
  ),
  paged AS (
    SELECT m.id, m.entry_date, m.voucher_series, m.voucher_number
    FROM matching m
    ORDER BY
      CASE WHEN p_sort_date = 'asc'  THEN m.entry_date END ASC  NULLS LAST,
      CASE WHEN p_sort_date = 'desc' THEN m.entry_date END DESC NULLS LAST,
      CASE WHEN p_sort_date = 'asc'  THEN m.voucher_series END ASC,
      CASE WHEN p_sort_date = 'desc' THEN m.voucher_series END DESC,
      CASE WHEN p_sort_date = 'asc'  THEN m.voucher_number END ASC,
      CASE WHEN p_sort_date = 'desc' THEN m.voucher_number END DESC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    to_jsonb(je.*)
      || jsonb_build_object(
        'lines', COALESCE(
          (SELECT jsonb_agg(to_jsonb(l.*) ORDER BY l.sort_order)
             FROM public.journal_entry_lines l
            WHERE l.journal_entry_id = je.id),
          '[]'::jsonb
        ),
        'out_of_period', (je.fiscal_period_id IS DISTINCT FROM p_period_id)
      ) AS entry,
    (SELECT COUNT(*) FROM matching) AS total_count
  FROM paged p
  JOIN public.journal_entries je ON je.id = p.id
  ORDER BY
    CASE WHEN p_sort_date = 'asc'  THEN p.entry_date END ASC  NULLS LAST,
    CASE WHEN p_sort_date = 'desc' THEN p.entry_date END DESC NULLS LAST,
    CASE WHEN p_sort_date = 'asc'  THEN p.voucher_series END ASC,
    CASE WHEN p_sort_date = 'desc' THEN p.voucher_series END DESC,
    CASE WHEN p_sort_date = 'asc'  THEN p.voucher_number END ASC,
    CASE WHEN p_sort_date = 'desc' THEN p.voucher_number END DESC;
$$;

NOTIFY pgrst, 'reload schema';
