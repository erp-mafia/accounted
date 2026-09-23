-- Validate the two salary_line_items CHECKs added NOT VALID in
-- 20260919120000 (calculation_source) and 20260919120200
-- (one_off_tax_percent). Kept separate to avoid the full-table scan under the
-- stronger DDL lock (same split as 20260906210300 / 20260906210301). Both
-- columns are NULL on every pre-existing row except the provenance backfill,
-- which satisfies its constraint by construction.

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_calculation_source_check;

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_one_off_tax_percent_check;
