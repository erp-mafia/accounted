-- Validate the item_type CHECK re-added NOT VALID in 20260813143000.
-- Kept separate to avoid a full-table scan under the stronger DDL lock.

ALTER TABLE public.salary_line_items
  VALIDATE CONSTRAINT salary_line_items_item_type_check;
