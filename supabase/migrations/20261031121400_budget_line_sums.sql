-- Budget amounts summed in the database (accounted#134, part 2).
--
-- A budget per home (one dimension value per property) holds accounts x 12
-- months x homes lines: 50 accounts and 100 homes are 60 000 rows. The grid's
-- summed view, the resultatrapport's Budget column and the per-dimension
-- report each need a sum over those lines, never the lines themselves, so
-- they ask for the sum here instead of paging every line through PostgREST.
--
-- p_dimensions filters the lines: by containment (a line tagged {1:K1, 6:P1}
-- counts for the filter {6:P1}, the resultatrapport's filter rule for journal
-- lines), or with p_exact by equality (the grid edits one exact tag, and {}
-- exactly is the untagged lines). p_by_month false sums over the window's
-- months; p_group_dim splits the sums per code of that dimension (null for a
-- line without it), the per-dimension report's columns.
--
-- SECURITY INVOKER: a session reads under its own RLS on budget_lines; the
-- v1 and MCP doors call it with the service role after their own company
-- check, and the company filter is explicit here as well. STABLE, reads only.

CREATE OR REPLACE FUNCTION public.get_budget_line_sums(
  p_company_id uuid,
  p_budget_id uuid,
  p_from date DEFAULT NULL,
  p_to date DEFAULT NULL,
  p_dimensions jsonb DEFAULT NULL,
  p_exact boolean DEFAULT false,
  p_by_month boolean DEFAULT true,
  p_group_dim text DEFAULT NULL
)
RETURNS TABLE (account_number text, month date, dim_code text, amount numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $$
  SELECT b.account_number,
         CASE WHEN p_by_month THEN b.month END AS month,
         CASE WHEN p_group_dim IS NOT NULL THEN b.dimensions ->> p_group_dim END AS dim_code,
         sum(b.amount) AS amount
    FROM public.budget_lines b
   WHERE b.company_id = p_company_id
     AND b.budget_id = p_budget_id
     AND (p_from IS NULL OR b.month >= p_from)
     AND (p_to IS NULL OR b.month <= p_to)
     AND (p_dimensions IS NULL
          OR (p_exact AND b.dimensions = p_dimensions)
          OR (NOT p_exact AND b.dimensions @> p_dimensions))
   GROUP BY 1, 2, 3
  HAVING sum(b.amount) <> 0;
$$;

REVOKE ALL ON FUNCTION public.get_budget_line_sums(uuid, uuid, date, date, jsonb, boolean, boolean, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_budget_line_sums(uuid, uuid, date, date, jsonb, boolean, boolean, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.get_budget_line_sums(uuid, uuid, date, date, jsonb, boolean, boolean, text) IS
  'A budget''s amounts summed per account (and month, and code of one dimension), SIE sign, for a window of months and a dimension filter (containment, or the exact tag). The grid''s summed view and the reports'' Budget columns. accounted#134.';

NOTIFY pgrst, 'reload schema';
