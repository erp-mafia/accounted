-- Validate salary_line_items_settles_variable_vacation_pay_check, added NOT
-- VALID in 20261125180000. Kept separate so the full-table scan runs under
-- the weaker lock (the split of 20261023142500 / 20261023142600). The column
-- is new and defaults to false, so every existing row passes.

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_settles_variable_vacation_pay_check;
