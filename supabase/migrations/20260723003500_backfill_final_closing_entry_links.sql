-- Repair only unambiguous final-closing links created by the canonical
-- year-end workflow. Other legacy closed periods remain unlinked so statutory
-- reporting fails explicitly instead of excluding unrelated year-end entries.

WITH exact_candidates AS (
  SELECT
    fp.id AS fiscal_period_id,
    (array_agg(je.id))[1] AS closing_entry_id
  FROM public.fiscal_periods fp
  JOIN public.journal_entries je
    ON je.company_id = fp.company_id
   AND je.fiscal_period_id = fp.id
   AND je.source_type = 'year_end'
   AND je.status = 'posted'
   AND je.description = 'Årsbokslut ' || fp.name
  WHERE fp.is_closed = true
    AND fp.closing_entry_id IS NULL
  GROUP BY fp.id
  HAVING count(*) = 1
)
UPDATE public.fiscal_periods fp
SET closing_entry_id = candidate.closing_entry_id
FROM exact_candidates candidate
WHERE fp.id = candidate.fiscal_period_id
  AND fp.closing_entry_id IS NULL;
