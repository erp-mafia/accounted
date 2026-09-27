-- Verifikationslista: the default collapsed view keeps a pure storno visible.
--
-- p_collapse_corrections folds a correction group (original, storno,
-- correction) into the live correction. The predicate hid the original only
-- when a posted correction replaced it, but hid EVERY storno on source_type
-- alone. A storno that merely cancels a voucher (no correction) therefore
-- vanished from the default list while its reversed original stayed, so the
-- series showed a hole at the storno's number and stornos at the end of the
-- series were invisible (#3149).
--
-- The rule is now symmetric: a row folds when a posted correction replaced the
-- group it belongs to, whether the row is the original (correction_of_id =
-- je.id) or its storno (correction_of_id = je.reverses_id). The route's
-- direct-query path applies the same rule.
--
-- Same 12-arg signature as 20260716140000, so CREATE OR REPLACE keeps the
-- existing GRANTs. Only the collapse predicate changes.

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
  matching AS (
    SELECT je.*
    FROM public.journal_entries je
    CROSS JOIN period p
    WHERE je.company_id = p_company_id
      AND (
        je.fiscal_period_id = p_period_id
        OR (
          p_include_related
          AND je.source_type IN ('invoice_paid','invoice_cash_payment','credit_note')
          AND EXISTS (
            SELECT 1 FROM public.invoices i
            WHERE i.id = je.source_id
              AND i.company_id = p_company_id
              AND i.invoice_date BETWEEN p.period_start AND p.period_end
          )
        )
        OR (
          p_include_related
          AND je.source_type IN ('supplier_invoice_paid','supplier_invoice_cash_payment','supplier_credit_note')
          AND EXISTS (
            SELECT 1 FROM public.supplier_invoices si
            WHERE si.id = je.source_id
              AND si.company_id = p_company_id
              AND si.invoice_date BETWEEN p.period_start AND p.period_end
          )
        )
      )
      AND (p_status IS NULL OR je.status = p_status)
      -- Hide cancelled by default; show them only when caller asks explicitly.
      AND (je.status <> 'cancelled' OR p_status = 'cancelled')
      -- Voucher-series filter (single letter A-Z). Inside the CTE so total_count
      -- below reflects the filtered set: this is the #798 fix.
      AND (p_series IS NULL OR je.voucher_series = p_series)
      -- Drafts live on their own surface; exclude them only on the committed
      -- list. Ignored when the caller asked for an explicit status (so a
      -- status='draft' request is never self-cancelled), mirroring the route's
      -- direct-query path.
      AND (NOT p_exclude_draft OR p_status IS NOT NULL OR je.status <> 'draft')
      -- Collapse a correction group to the live correction: fold the reversed
      -- original and its storno once a posted correction has replaced them.
      -- A storno with no correction stays visible: it is the only row that
      -- carries its voucher number (#3149).
      AND (
        NOT p_collapse_corrections
        OR NOT EXISTS (
          SELECT 1 FROM public.journal_entries c
          WHERE c.company_id = p_company_id
            AND c.source_type = 'correction'
            AND c.status = 'posted'
            AND c.correction_of_id = CASE
              WHEN je.source_type = 'storno' THEN je.reverses_id
              ELSE je.id
            END
        )
      )
      AND (p_date_from IS NULL OR je.entry_date >= p_date_from)
      AND (p_date_to IS NULL OR je.entry_date <= p_date_to)
  ),
  matching_with_total AS (
    SELECT m.*, COUNT(*) OVER () AS total
    FROM matching m
  ),
  paged AS (
    SELECT *
    FROM matching_with_total
    ORDER BY
      CASE WHEN p_sort_date = 'asc'  THEN entry_date END ASC  NULLS LAST,
      CASE WHEN p_sort_date = 'desc' THEN entry_date END DESC NULLS LAST,
      CASE WHEN p_sort_date = 'asc'  THEN voucher_series END ASC,
      CASE WHEN p_sort_date = 'desc' THEN voucher_series END DESC,
      CASE WHEN p_sort_date = 'asc'  THEN voucher_number END ASC,
      CASE WHEN p_sort_date = 'desc' THEN voucher_number END DESC
    LIMIT p_limit OFFSET p_offset
  )
  SELECT
    (to_jsonb(p.*) - 'total')
      || jsonb_build_object(
        'lines', COALESCE(
          (SELECT jsonb_agg(to_jsonb(l.*) ORDER BY l.sort_order)
             FROM public.journal_entry_lines l
            WHERE l.journal_entry_id = p.id),
          '[]'::jsonb
        ),
        'out_of_period', (p.fiscal_period_id IS DISTINCT FROM p_period_id)
      ) AS entry,
    p.total AS total_count
  FROM paged p
  ORDER BY
    CASE WHEN p_sort_date = 'asc'  THEN p.entry_date END ASC  NULLS LAST,
    CASE WHEN p_sort_date = 'desc' THEN p.entry_date END DESC NULLS LAST,
    CASE WHEN p_sort_date = 'asc'  THEN p.voucher_series END ASC,
    CASE WHEN p_sort_date = 'desc' THEN p.voucher_series END DESC,
    CASE WHEN p_sort_date = 'asc'  THEN p.voucher_number END ASC,
    CASE WHEN p_sort_date = 'desc' THEN p.voucher_number END DESC;
$$;

NOTIFY pgrst, 'reload schema';
