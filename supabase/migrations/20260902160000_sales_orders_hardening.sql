-- Kundorder hardening (skeptic + security review of PR #2166).
--
-- Additive follow-up to 20260902130000_sales_orders.sql:
--
--   1. Tenant consistency between an order line and its parent order is now
--      a database invariant: a composite FK (sales_order_id, company_id)
--      -> sales_orders (id, company_id). Before this, the line's own
--      company_id and its parent reference were independently writable, so
--      a PostgREST caller could park a line under its own company while
--      pointing at another tenant's order (Superagent P2).
--   2. Both tables get the same aa_enforce_company_writer_role gate as every
--      other membership-only table (20260902093000), so a viewer cannot
--      write through the browser Supabase client. Routes already carry
--      requireWrite; this is the defense-in-depth layer.
--   3. Per-line delivery date. The header last_delivery_date is the latest
--      delivery across ALL lines; using it as the invoice's delivery_date
--      stamps a wrong leveransdatum (ML 17 kap 24 § p.7) and a wrong FX
--      anchor (ML 8 kap 21-23 §) on an invoice for lines delivered earlier.
--      Each line now remembers its own latest delivery date and the invoice
--      takes the latest over the lines it actually covers, only when every
--      covered quantity has been delivered.
--   4. Customer VAT snapshot. Order lines freeze a VAT rate that was lawful
--      for the customer at order time. If the customer's type or VAT-number
--      validation changes before invoicing (an EU business validated later,
--      or reclassified as domestic), the frozen rate can still pass the
--      permitted-set gate (25 % is permitted for a validated EU business via
--      the ML 6 kap. exceptions) and land silently on the invoice. The order
--      stores the customer facts it was priced under; invoicing refuses when
--      they changed until the order is re-saved (which re-validates the
--      lines against the current rules).

-- 1. Composite tenant FK -----------------------------------------------------
ALTER TABLE public.sales_orders
  ADD CONSTRAINT sales_orders_id_company_id_key UNIQUE (id, company_id);

ALTER TABLE public.sales_order_items
  ADD CONSTRAINT sales_order_items_order_company_fkey
  FOREIGN KEY (sales_order_id, company_id)
  REFERENCES public.sales_orders (id, company_id)
  ON DELETE CASCADE;

-- 2. Writer-role gate (mirrors 20260902093000) -------------------------------
DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.sales_orders;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.sales_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.sales_order_items;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.sales_order_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- 3. Per-line delivery date --------------------------------------------------
ALTER TABLE public.sales_order_items
  ADD COLUMN IF NOT EXISTS last_delivery_date date;

COMMENT ON COLUMN public.sales_order_items.last_delivery_date IS
  'Latest registered delivery date for this line. An invoice created from the order uses the latest over the lines it covers as delivery_date, only when the covered quantity has been delivered.';

-- 4. Customer VAT snapshot ---------------------------------------------------
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS customer_type_snapshot text
    CHECK (customer_type_snapshot IN ('individual', 'swedish_business', 'eu_business', 'non_eu_business'));
ALTER TABLE public.sales_orders
  ADD COLUMN IF NOT EXISTS customer_vat_validated_snapshot boolean;

COMMENT ON COLUMN public.sales_orders.customer_type_snapshot IS
  'customer_type the lines were VAT-validated under. Invoicing refuses when the customer no longer matches; re-saving the order refreshes it.';

NOTIFY pgrst, 'reload schema';
