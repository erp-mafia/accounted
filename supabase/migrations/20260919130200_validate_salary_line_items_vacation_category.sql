-- Validate the two salary_line_items CHECKs added NOT VALID in
-- 20260919130100 (vacation_category, vacation_saved_year). Kept separate to
-- avoid the full-table scan under the stronger DDL lock (same split as
-- 20260919120200 / 20260919120300). Both columns are NULL on every
-- pre-existing row, so the scan finds nothing to refuse.

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_vacation_category_check;

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_vacation_saved_year_check;
