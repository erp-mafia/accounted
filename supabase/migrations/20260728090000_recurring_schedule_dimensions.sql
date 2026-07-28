-- Recurring schedules carry dimension tags so cron-generated invoices are
-- born with the same {sie_dim_no: code} bags a manually created invoice
-- would have (dimensions PR7 producer parity).
--
--   recurring_invoice_schedules.default_dimensions
--     copied verbatim onto invoices.default_dimensions at spawn time; the
--     invoice entry generators then apply it to every journal line.
--   recurring_invoice_schedule_items.dimensions
--     copied onto invoice_items.dimensions per generated item; merged OVER
--     the invoice default on the revenue line that item books to.
--
-- Same shape + CHECK as invoices/invoice_items (20260702200000). No indexes:
-- read via their parent row when spawning invoices, never containment-queried.
-- NOT NULL DEFAULT '{}' is metadata-only on PG11+ (no table rewrite).
--
-- pg-test: covered-by — plain column adds with a type CHECK, no
-- trigger/RPC/RLS/DEFERRABLE change. Propagation logic is TS-side
-- (lib/invoices/recurring-schedule-service.ts unit tests).

ALTER TABLE public.recurring_invoice_schedules
  ADD COLUMN default_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.recurring_invoice_schedules
  ADD CONSTRAINT recurring_invoice_schedules_default_dimensions_is_object
  CHECK (jsonb_typeof(default_dimensions) = 'object');

ALTER TABLE public.recurring_invoice_schedule_items
  ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.recurring_invoice_schedule_items
  ADD CONSTRAINT recurring_invoice_schedule_items_dimensions_is_object
  CHECK (jsonb_typeof(dimensions) = 'object');

COMMENT ON COLUMN public.recurring_invoice_schedules.default_dimensions IS
  'Dimension bag {sie_dim_no: code} copied onto invoices.default_dimensions for every invoice this schedule generates. See lib/invoices/recurring-schedule-service.ts.';
COMMENT ON COLUMN public.recurring_invoice_schedule_items.dimensions IS
  'Per-item dimension bag copied onto invoice_items.dimensions for the generated item; merges over the schedule default on the revenue line.';

NOTIFY pgrst, 'reload schema';
