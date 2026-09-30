-- detect_voucher_gaps: count the numbers before the first voucher (#3150).
--
-- The gap query paired each non-draft voucher with the next one (LEAD), so it
-- only saw holes between two surviving numbers. A series whose lowest number
-- is 6 reported nothing for 1-5, although every series starts at 1 in its
-- fiscal period (next_voucher_number / commit_journal_entry). The gap page,
-- year-end readiness and the compliance check all read this function, so a
-- leading gap never blocked year-end and an explanation written for it was
-- never matched in the UI.
--
-- Fix: seed the window with 0, the number before the first voucher, so the
-- lowest real number is compared against it like any other neighbour. Drafts
-- stay excluded (they carry voucher_number 0 and hold no number); every other
-- status still counts as a used number. Guard and grants otherwise unchanged
-- from the live definition (20260702093000, guard rewritten by 20260703180000).
CREATE OR REPLACE FUNCTION public.detect_voucher_gaps(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_series text DEFAULT 'A'::text
)
RETURNS TABLE(gap_start integer, gap_end integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  WITH used AS (
    SELECT 0 AS voucher_number
    UNION ALL
    SELECT je.voucher_number
    FROM public.journal_entries je
    WHERE je.company_id = p_company_id
      AND je.fiscal_period_id = p_fiscal_period_id
      AND je.voucher_series = p_series
      AND je.status != 'draft'
  ),
  numbered AS (
    SELECT used.voucher_number,
           LEAD(used.voucher_number) OVER (ORDER BY used.voucher_number) AS next_number
    FROM used
  )
  SELECT
    numbered.voucher_number + 1 AS gap_start,
    numbered.next_number - 1 AS gap_end
  FROM numbered
  WHERE numbered.next_number IS NOT NULL
    AND numbered.next_number > numbered.voucher_number + 1
  ORDER BY 1;
END;
$function$;

REVOKE ALL ON FUNCTION public.detect_voucher_gaps(uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.detect_voucher_gaps(uuid, uuid, text) TO authenticated;

NOTIFY pgrst, 'reload schema';
