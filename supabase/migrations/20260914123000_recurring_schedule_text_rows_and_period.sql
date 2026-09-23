-- Recurring invoice schedules: free-text rows and a billing period.
--
-- Text rows: recurring_invoice_schedule_items gains line_type (product | text)
-- to mirror invoice_items.line_type (migration 20260620140000). A text row
-- carries only a description (which may be empty, for a spacer) and no
-- amounts; the spawn copies it onto the generated invoice as a text row, so
-- it never books. The two column CHECKs that required a non-empty
-- description and a positive quantity are re-expressed to apply to product
-- rows only.
--
-- Period: period_start is the first day of the billing period the NEXT
-- generated invoice covers. Placeholders in notes and line descriptions
-- ({periodstart}, {periodslut}, {nästa periodstart}, {månad}, {år}, ...) are
-- substituted at spawn time (lib/invoices/recurring-placeholders.ts); after a
-- successful run the cron (and "Skapa faktura nu") advances period_start by
-- interval_months. NULL = the schedule has no period and the period
-- placeholders are refused at save time.

ALTER TABLE public.recurring_invoice_schedules
  ADD COLUMN period_start date;

COMMENT ON COLUMN public.recurring_invoice_schedules.period_start IS
  'First day of the billing period the next generated invoice covers; advanced by interval_months after every run. NULL = no period placeholders.';

ALTER TABLE public.recurring_invoice_schedule_items
  ADD COLUMN line_type text NOT NULL DEFAULT 'product'
    CHECK (line_type IN ('product', 'text')),
  DROP CONSTRAINT recurring_invoice_schedule_items_description_check,
  DROP CONSTRAINT recurring_invoice_schedule_items_quantity_check,
  ADD CONSTRAINT recurring_invoice_schedule_items_product_line_shape
    CHECK (line_type = 'text' OR (length(description) > 0 AND quantity > 0));

COMMENT ON COLUMN public.recurring_invoice_schedule_items.line_type IS
  'product = billable template line; text = free-text/blank row copied onto the generated invoice as a text row (description only, no amounts).';

NOTIFY pgrst, 'reload schema';
