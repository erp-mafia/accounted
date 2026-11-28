-- Change feed indexes: ?updated_since on the v1 list endpoints (#3651).
--
-- GET /api/v1/companies/{id}/{invoices,supplier-invoices,customers,suppliers,
-- employees}?updated_since=... reads
--   WHERE company_id = $1 AND updated_at >= $2
--     [AND (updated_at, id) > ($3, $4)]
--   ORDER BY updated_at, id LIMIT n
-- None of the five tables has an index that starts with (company_id,
-- updated_at), so each page would read every row the company has and sort
-- it. (company_id, updated_at, id) serves the filter, the keyset and the
-- order in one index range scan, and a sync that polls every few minutes
-- touches only the rows changed since its last call.
--
-- updated_at on all five is kept by the update_updated_at_column() BEFORE
-- UPDATE trigger (customers_updated_at, invoices_updated_at,
-- set_updated_at_supplier_invoices, set_updated_at_suppliers,
-- employees_updated_at), which is what makes it safe to page on.
--
-- Plain CREATE INDEX, not CONCURRENTLY (precedent 20261112214703): each build
-- holds its SHARE lock briefly, and lock_timeout caps the wait behind an open
-- write at 5 s; past it the migration fails whole and is run again
-- (IF NOT EXISTS).
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_invoices_company_updated_at
  ON public.invoices (company_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_supplier_invoices_company_updated_at
  ON public.supplier_invoices (company_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_customers_company_updated_at
  ON public.customers (company_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_suppliers_company_updated_at
  ON public.suppliers (company_id, updated_at, id);

CREATE INDEX IF NOT EXISTS idx_employees_company_updated_at
  ON public.employees (company_id, updated_at, id);
