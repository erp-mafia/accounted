-- Supplier invoice item VAT rates use decimal fractions (0.25 = 25 %).
-- Keep the guard NOT VALID so existing legacy percent-shaped rows do not
-- block deployment; PostgreSQL still enforces it for every new or updated row.
ALTER TABLE public.supplier_invoice_items
  ADD CONSTRAINT supplier_invoice_items_vat_rate_fraction
  CHECK (vat_rate BETWEEN 0 AND 1)
  NOT VALID;

COMMENT ON CONSTRAINT supplier_invoice_items_vat_rate_fraction
  ON public.supplier_invoice_items
  IS 'Supplier invoice VAT rate stored as a decimal fraction between 0 and 1.';
