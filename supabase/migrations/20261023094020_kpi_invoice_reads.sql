-- The KPI report's two invoice reads, one call each
-- (lib/reports/kpi.ts: fetchPaymentDaysInRange, fetchTopSupplierInvoices).
--
-- Why: the average payment days paged `invoices(invoice_date, paid_at)` 1 000
-- rows per round trip to count and sum in TypeScript (13 round trips for a
-- year of 12 285 paid invoices), and "Största leverantörer" paged the
-- period's supplier invoices the same way (5 round trips for 4 000).
--
-- get_paid_invoice_days answers the payment-days question in SQL: the
-- number of paid invoices whose payment landed in [p_from, p_paid_before)
-- and the sum of their whole days from invoice date to payment, each never
-- below zero. A day count is the one calculateAvgPaymentDays made: from the
-- invoice date at midnight UTC to paid_at truncated to the millisecond (what
-- a JavaScript Date keeps of it), floored. Integers, so the sum is exact.
--
-- get_kpi_supplier_invoices returns the period's supplier invoices (credited
-- left out) as one json array in id order, with the supplier's name: the rows
-- aggregateTopSuppliers sums in TypeScript, whose float sums and first-seen
-- order depend on that order. A scalar result, so PostgREST's max-rows cap
-- does not apply.
--
-- SECURITY INVOKER: RLS scopes every table to the caller, and every read also
-- filters on p_company_id.

CREATE OR REPLACE FUNCTION public.get_paid_invoice_days(
  p_company_id uuid,
  p_from date,
  p_paid_before date
)
RETURNS json
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  SELECT json_build_object(
    'invoice_count', count(*),
    'total_days', coalesce(sum(greatest(0, floor(
      (floor(extract(epoch FROM i.paid_at) * 1000)
        - (i.invoice_date - DATE '1970-01-01')::numeric * 86400000)
      / 86400000
    ))), 0)
  )
  FROM public.invoices i
  WHERE i.company_id = p_company_id
    AND i.status = 'paid'
    AND i.paid_at >= p_from::timestamptz
    AND i.paid_at < p_paid_before::timestamptz
$$;

COMMENT ON FUNCTION public.get_paid_invoice_days(uuid, date, date) IS
  'Paid invoices whose payment landed in [p_from, p_paid_before) and the sum of their payment days (invoice date to paid_at, floored, never negative): the KPI report''s average payment days. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.get_paid_invoice_days(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_paid_invoice_days(uuid, date, date) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_kpi_supplier_invoices(
  p_company_id uuid,
  p_from date,
  p_to date
)
RETURNS json
LANGUAGE sql
STABLE
SET search_path TO ''
AS $$
  SELECT coalesce(json_agg(row_to_json(r) ORDER BY si.id), '[]'::json)
  FROM public.supplier_invoices si
  CROSS JOIN LATERAL (
    SELECT si.supplier_id,
           (SELECT s.name FROM public.suppliers s WHERE s.id = si.supplier_id) AS supplier_name,
           si.total, si.total_sek, si.currency, si.exchange_rate
  ) r
  WHERE si.company_id = p_company_id
    AND si.invoice_date >= p_from
    AND si.invoice_date <= p_to
    AND si.status <> 'credited'
$$;

COMMENT ON FUNCTION public.get_kpi_supplier_invoices(uuid, date, date) IS
  'The supplier invoices of a date range (credited left out) with their supplier''s name, as one json array in id order: the rows the KPI report''s top suppliers sum. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.get_kpi_supplier_invoices(uuid, date, date) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_kpi_supplier_invoices(uuid, date, date) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
