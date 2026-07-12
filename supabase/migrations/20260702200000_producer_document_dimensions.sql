-- Dimensions PR7 (producers): source documents carry dimension tags so the
-- entry generators can propagate them onto journal lines.
--
--   invoices.default_dimensions / supplier_invoices.default_dimensions
--     {sie_dim_no: code} bag applied to EVERY generated line (issuance,
--     payment, credit — payment vouchers re-propagate from the linked
--     invoice under both accounting methods).
--   invoice_items.dimensions / supplier_invoice_items.dimensions
--     per-item bag merged OVER the invoice default on the revenue/expense
--     line that item books to (item wins per key).
--
-- Same shape + CHECK as journal_entry_lines.dimensions (20260702084500).
-- No indexes: these columns are read via their parent row when generating
-- entries, never containment-queried — reporting queries hit the GIN on
-- journal_entry_lines. NOT NULL DEFAULT '{}' is metadata-only on PG11+.
--
-- pg-test: covered-by — plain column adds with a type CHECK, no
-- trigger/RPC/RLS/DEFERRABLE change. Propagation logic is TS-side
-- (lib/bookkeeping/{invoice,supplier-invoice}-entries.ts unit tests).

ALTER TABLE public.invoices
  ADD COLUMN default_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_default_dimensions_is_object
  CHECK (jsonb_typeof(default_dimensions) = 'object');

ALTER TABLE public.invoice_items
  ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.invoice_items
  ADD CONSTRAINT invoice_items_dimensions_is_object
  CHECK (jsonb_typeof(dimensions) = 'object');

ALTER TABLE public.supplier_invoices
  ADD COLUMN default_dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.supplier_invoices
  ADD CONSTRAINT supplier_invoices_default_dimensions_is_object
  CHECK (jsonb_typeof(default_dimensions) = 'object');

ALTER TABLE public.supplier_invoice_items
  ADD COLUMN dimensions jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.supplier_invoice_items
  ADD CONSTRAINT supplier_invoice_items_dimensions_is_object
  CHECK (jsonb_typeof(dimensions) = 'object');

COMMENT ON COLUMN public.invoices.default_dimensions IS
  'Dimension bag {sie_dim_no: code} applied to every journal line generated from this invoice; invoice_items.dimensions merges over it per revenue line. See lib/bookkeeping/invoice-entries.ts.';
COMMENT ON COLUMN public.invoice_items.dimensions IS
  'Per-item dimension bag merged over invoices.default_dimensions on the revenue line this item books to.';
COMMENT ON COLUMN public.supplier_invoices.default_dimensions IS
  'Dimension bag {sie_dim_no: code} applied to every journal line generated from this supplier invoice; supplier_invoice_items.dimensions merges over it per expense line. See lib/bookkeeping/supplier-invoice-entries.ts.';
COMMENT ON COLUMN public.supplier_invoice_items.dimensions IS
  'Per-item dimension bag merged over supplier_invoices.default_dimensions on the expense line this item books to.';

NOTIFY pgrst, 'reload schema';
