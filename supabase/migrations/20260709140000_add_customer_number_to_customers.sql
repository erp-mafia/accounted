-- Customer number (kundnummer) on customers, shown on the invoice (issue #914).
--
-- Nullable free text set by the user. Deliberately NO unique constraint in v1:
-- existing rows, register imports, and provider syncs must not start failing
-- on duplicates. Auto-numbering and uniqueness can be layered on later.
--
-- No RLS changes needed: customers already has company-scoped policies and a
-- plain column add inherits them.

ALTER TABLE public.customers
  ADD COLUMN IF NOT EXISTS customer_number text;

COMMENT ON COLUMN public.customers.customer_number IS
  'User-assigned customer number (kundnummer) printed on invoices. Free text, not unique in v1.';

NOTIFY pgrst, 'reload schema';
