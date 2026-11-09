-- accounted#154: one live filing record per company and VAT period.
--
-- The index covers completed rows only. A pending row is the deadline, not
-- the filing: the deadline generator inserts a period's replacement row
-- before it deletes the old pending one, so pending rows of one period
-- briefly coexist by design, and a stale past-due pending row is never
-- deleted by it at all. Two completed rows of one period are the race this
-- closes (two kvittens reads, or a manual mark racing one): the writers in
-- src/lib/vat/filing-record-store.ts catch the refusal and read again.
SELECT set_config('lock_timeout', '5s', true);

-- Rows that already break the rule (prod 2026-11-07: one period with two
-- completed 'submitted' rows recording the same filing). Keep one record:
-- a Skatteverket confirmation first, then a row carrying notes (the filing
-- reference), then the newest row, which the generator built with the
-- current due date. The others are dismissed, never deleted: dismissal is
-- reversible and the generator treats a dismissed row as an opt-out.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY company_id, tax_deadline_type, tax_period
           ORDER BY (status = 'confirmed') DESC NULLS LAST,
                    (notes IS NOT NULL) DESC,
                    created_at DESC,
                    id
         ) AS keep_rank
    FROM public.deadlines
   WHERE dismissed_at IS NULL
     AND is_completed
     AND tax_period IS NOT NULL
     AND tax_deadline_type IN ('moms_monthly', 'moms_quarterly', 'moms_yearly')
)
UPDATE public.deadlines d
   SET dismissed_at = now()
  FROM ranked
 WHERE d.id = ranked.id
   AND ranked.keep_rank > 1;

CREATE UNIQUE INDEX IF NOT EXISTS idx_deadlines_vat_filing_period_unique
  ON public.deadlines (company_id, tax_deadline_type, tax_period)
  WHERE dismissed_at IS NULL
    AND is_completed
    AND tax_period IS NOT NULL
    AND tax_deadline_type IN ('moms_monthly', 'moms_quarterly', 'moms_yearly');

NOTIFY pgrst, 'reload schema';
