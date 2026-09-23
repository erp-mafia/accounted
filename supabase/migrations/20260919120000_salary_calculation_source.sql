-- Engine-row provenance on salary_line_items (policy track of #2729).
-- pg-test: supabase/migrations/__tests__/salary-calculation-policy.pg.test.ts
--
-- lib/salary/run-calculation.ts re-derives the semesterersättning row
-- (vacation_rule = 'semesterersattning') on every :calculate. Until now it
-- matched that row by item_type alone, so a semesterersättning line an
-- operator entered by hand (a final settlement, a variable-pay top-up, a line
-- carrying engångsskatt) was deleted on the next recalculation and never
-- reached the engine. The wage type cannot carry provenance because operators
-- legitimately enter the same type; this column does. NULL = manual row,
-- 'vacation_compensation' = written and owned by the engine.
--
-- The CHECK is added NOT VALID and validated in 20260919120300, the same
-- split as the item_type CHECK (20260906210300 / 20260906210301), so the
-- DDL takes the lighter lock; every existing row is NULL and passes.

ALTER TABLE public.salary_line_items
  ADD COLUMN IF NOT EXISTS calculation_source text;

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT IF EXISTS salary_line_items_calculation_source_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_calculation_source_check
  CHECK (calculation_source IS NULL OR calculation_source = 'vacation_compensation')
  NOT VALID;

-- Rows the engine wrote before this column existed carry its exact
-- signature (item_type semesterersattning, description 'Semesterersättning',
-- sort_order 50). Marking them engine-owned reproduces what every
-- recalculation did to them until now (delete and re-derive). A hand-entered
-- row that happened to match would have been deleted by that same
-- recalculation, so nothing that survives today is lost. Runs past draft are
-- never recalculated; their rows get the marker for a consistent history only.
UPDATE public.salary_line_items
   SET calculation_source = 'vacation_compensation'
 WHERE item_type = 'semesterersattning'
   AND calculation_source IS NULL
   AND description = 'Semesterersättning'
   AND sort_order = 50;

COMMENT ON COLUMN public.salary_line_items.calculation_source IS
  'Engine provenance: vacation_compensation on the semesterersättning row run-calculation derives and replaces on every calculate. NULL = manually entered row, preserved across recalculations.';

NOTIFY pgrst, 'reload schema';
