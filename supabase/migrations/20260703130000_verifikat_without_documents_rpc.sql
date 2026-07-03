-- RPC: verifikat_without_documents — SQL-side filtering + pagination for the
-- MCP tool gnubok_list_verifikat_without_documents.
--
-- Bug fix (dev_docs/mcp_optimization_plan.md P0-2): the tool applied
-- min_amount IN MEMORY after the PostgREST .range() page, because
-- gross_amount is an aggregate (sum of debit lines) PostgREST cannot filter
-- on. Consequences: total_count ignored the filter, and next_offset advanced
-- by the filtered row count while the DB page consumed `limit` rows — so the
-- next page overlapped the previous page's tail. Agents paging a backlog got
-- duplicates and could not prove full coverage.
--
-- This function computes gross_amount, applies since/min_amount, counts and
-- paginates all in SQL, returning a filter-respecting total alongside the
-- page. Ordering carries an id tiebreak so pagination is total and stable.
--
-- Tenant guard (mirrors 20260615120000): anon/authenticated callers must be
-- members of p_company_id; service_role bypasses (MCP tools already scope by
-- company_id).
--
-- pg-test: tests/pg/verifikat-without-documents-rpc.pg.test.ts (pagination
-- invariants: disjoint pages, complete union, filter-respecting total, since
-- filter, tenant guard).

CREATE OR REPLACE FUNCTION public.verifikat_without_documents(
  p_company_id uuid,
  p_since date DEFAULT NULL,
  p_min_amount numeric DEFAULT 0,
  p_limit integer DEFAULT 20,
  p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 100);
  v_offset integer := greatest(coalesce(p_offset, 0), 0);
  v_min numeric := greatest(coalesce(p_min_amount, 0), 0);
  v_result jsonb;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    -- NOT IN (subquery) evaluates to UNKNOWN when either side yields NULL,
    -- which would silently skip this deny branch — use NOT EXISTS and reject
    -- a NULL company id outright.
    IF p_company_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.user_company_ids() AS c(id) WHERE c.id = p_company_id
    ) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'VERIFIKAT_WITHOUT_DOCUMENTS_FORBIDDEN');
    END IF;
  END IF;

  WITH candidates AS (
    SELECT
      je.id,
      je.voucher_series,
      je.voucher_number,
      je.entry_date,
      je.description,
      je.source_type,
      round(coalesce(sum(l.debit_amount), 0), 2) AS gross_amount
    FROM journal_entries je
    LEFT JOIN journal_entry_lines l ON l.journal_entry_id = je.id
    WHERE je.company_id = p_company_id
      AND je.status = 'posted'
      AND NOT EXISTS (
        SELECT 1 FROM document_attachments d WHERE d.journal_entry_id = je.id
      )
      AND (p_since IS NULL OR je.entry_date >= p_since)
    GROUP BY je.id
    HAVING round(coalesce(sum(l.debit_amount), 0), 2) >= v_min
  ),
  total AS (
    SELECT count(*) AS n FROM candidates
  ),
  page AS (
    SELECT * FROM candidates
    ORDER BY entry_date DESC, voucher_number DESC, id DESC
    LIMIT v_limit OFFSET v_offset
  )
  SELECT jsonb_build_object(
    'ok', true,
    'total_count', (SELECT n FROM total),
    'verifikat', coalesce(
      (SELECT jsonb_agg(
         jsonb_build_object(
           'journal_entry_id', p.id,
           'voucher_series', p.voucher_series,
           'voucher_number', p.voucher_number,
           'entry_date', p.entry_date,
           'description', p.description,
           'source_type', p.source_type,
           'gross_amount', p.gross_amount
         )
         ORDER BY p.entry_date DESC, p.voucher_number DESC, p.id DESC
       ) FROM page p),
      '[]'::jsonb
    )
  )
  INTO v_result;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.verifikat_without_documents(uuid, date, numeric, integer, integer) TO authenticated, service_role;

-- Anti-join + link lookups both hit document_attachments by journal_entry_id;
-- the FK carries no index by default.
CREATE INDEX IF NOT EXISTS idx_document_attachments_journal_entry_id
  ON public.document_attachments (journal_entry_id);

NOTIFY pgrst, 'reload schema';
