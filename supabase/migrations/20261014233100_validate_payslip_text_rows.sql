-- Validate the two salary_line_items CHECKs added NOT VALID in
-- 20261014233000 (item_type with 'text', salary_line_items_text_row). Kept
-- separate to avoid the full-table scan under the stronger DDL lock (same
-- split as 20260906210300 / 20260906210301). No pre-existing row is 'text',
-- so the scan finds nothing to refuse.

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_item_type_check;

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_text_row;
