-- Validate salary_line_items_calculation_source_check, re-added NOT VALID in
-- 20261023142500 with the vacation_pay value (issue #85). Kept separate so
-- the full-table scan runs under the weaker lock (the split of
-- 20260919120000 / 20260919120300). Every existing row is NULL or
-- 'vacation_compensation' and passes.

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_calculation_source_check;
