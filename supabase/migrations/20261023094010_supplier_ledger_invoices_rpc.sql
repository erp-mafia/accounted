-- get_supplier_ledger_invoices: the leverantörsreskontra population in one
-- call, the supplier twin of get_ar_ledger_invoices
-- (20261023093950_ar_ledger_invoices_rpc.sql).
--
-- Why: generateSupplierLedger read `supplier_invoices.* + supplier` 1 000 rows
-- per round trip and, as of a past date, every supplier_invoice_payments row
-- of the company the same way; generateReconciliation read the open invoices
-- again. A backdated leverantörsreskontra of 4 800 invoices took 11 round
-- trips.
--
-- What it returns: one json array, one object per invoice of the ledger
-- population, ordered by id, with the facts lib/reports/supplier-ledger.ts
-- reads (mapped in lib/reports/supplier-ledger-invoices.ts). The rules stay in
-- TypeScript. p_as_of_date NULL is the live open-invoice state; a date is the
-- historical population as of that date. p_supplier_id narrows to one
-- supplier and adds each invoice's registration verifikat (the drill-down's).
--
-- As of a date, paid invoices whose outstanding is exactly zero on the date
-- are left out, as the walk skips them: decided only where the arithmetic is
-- provably the walk's own (payment rows that sum exactly to the total, all in
-- whole öre, or no payment rows and remaining_amount 0 with no paid_at after
-- the date), and never for a foreign-currency invoice without a rate, which
-- the walk counts as unconverted before it looks at its outstanding. The walk
-- creates a supplier's entry only for a row it keeps, so id order is the
-- order it needs.
--
-- SECURITY INVOKER: RLS scopes every table to the caller, and every read also
-- filters on p_company_id. plan_cache_mode force_custom_plan, as in
-- get_ar_ledger_invoices.

CREATE OR REPLACE FUNCTION public.get_supplier_ledger_invoices(
  p_company_id uuid,
  p_as_of_date date DEFAULT NULL,
  p_supplier_id uuid DEFAULT NULL
)
RETURNS json
LANGUAGE plpgsql
STABLE
SET search_path TO ''
SET plan_cache_mode TO 'force_custom_plan'
AS $$
BEGIN
  RETURN (
    WITH population AS MATERIALIZED (
      SELECT si.id, si.supplier_id, si.supplier_invoice_number, si.arrival_number, si.invoice_date,
             si.due_date, si.status, si.total, si.paid_amount, si.remaining_amount, si.currency,
             si.exchange_rate, si.paid_at, si.registration_journal_entry_id
      FROM public.supplier_invoices si
      WHERE si.company_id = p_company_id
        AND (p_supplier_id IS NULL OR si.supplier_id = p_supplier_id)
        AND CASE
              WHEN p_as_of_date IS NULL THEN
                si.status IN ('registered', 'approved', 'partially_paid', 'overdue')
              ELSE
                -- COLLATE "C": see get_ar_ledger_invoices.
                (si.status COLLATE "C") IN ('registered', 'approved', 'partially_paid', 'overdue', 'paid')
                AND si.invoice_date <= p_as_of_date
            END
    ),
    payments AS (
      SELECT sp.supplier_invoice_id,
             coalesce(sum(sp.amount) FILTER (WHERE sp.payment_date <= p_as_of_date), 0) AS paid_through,
             coalesce(bool_and(sp.amount = round(sp.amount, 2)) FILTER (WHERE sp.payment_date <= p_as_of_date), true) AS in_ore
      FROM public.supplier_invoice_payments sp
      WHERE p_as_of_date IS NOT NULL
        AND sp.company_id = p_company_id
      GROUP BY sp.supplier_invoice_id
    ),
    survivors AS (
      SELECT p.*, pay.supplier_invoice_id IS NOT NULL AS has_payment_rows
      FROM population p
      LEFT JOIN payments pay ON pay.supplier_invoice_id = p.id
      WHERE NOT coalesce(
        p_as_of_date IS NOT NULL
        AND p.status = 'paid'
        -- A foreign invoice without a rate is counted as unconverted.
        AND NOT (coalesce(p.currency, '') NOT IN ('', 'SEK') AND NOT coalesce(p.exchange_rate > 0, false))
        AND CASE
              WHEN pay.supplier_invoice_id IS NOT NULL THEN
                p.total = round(p.total, 2) AND pay.in_ore AND pay.paid_through = p.total
              ELSE
                p.remaining_amount = 0
                AND (p.paid_at IS NULL
                     -- The walk compares the date part of paid_at as
                     -- PostgREST prints it, in the session time zone.
                     OR left(to_json(p.paid_at) #>> '{}', 10) COLLATE "C" <= p_as_of_date::text COLLATE "C")
            END,
        false
      )
    )
    SELECT coalesce(json_agg(row_to_json(r) ORDER BY s.id), '[]'::json)
    FROM survivors s
    CROSS JOIN LATERAL (
      SELECT s.id, s.supplier_id,
             (SELECT sup.name FROM public.suppliers sup WHERE sup.id = s.supplier_id) AS supplier_name,
             s.supplier_invoice_number, s.arrival_number, s.invoice_date, s.due_date, s.status,
             s.total, s.paid_amount, s.remaining_amount, s.currency, s.exchange_rate, s.paid_at,
             s.registration_journal_entry_id, s.has_payment_rows,
             -- As of a date: the amounts of the payment rows dated on or
             -- before it, in id order (fetchPaymentsAsOf's walk).
             CASE WHEN s.has_payment_rows THEN (
               SELECT coalesce(array_agg(sp.amount ORDER BY sp.id), '{}')
               FROM public.supplier_invoice_payments sp
               WHERE sp.company_id = p_company_id
                 AND sp.supplier_invoice_id = s.id
                 AND sp.payment_date <= p_as_of_date
             ) END AS payment_amounts,
             -- One supplier: the registration verifikat, when posted.
             CASE WHEN p_supplier_id IS NOT NULL THEN (
               SELECT json_build_object('voucher_number', e.voucher_number, 'voucher_series', e.voucher_series,
                                        'description', e.description, 'entry_date', e.entry_date)
               FROM public.journal_entries e
               WHERE e.company_id = p_company_id
                 AND e.id = s.registration_journal_entry_id
                 AND e.status IN ('posted', 'reversed')
             ) END AS registration_entry
    ) r
  );
END;
$$;

COMMENT ON FUNCTION public.get_supplier_ledger_invoices(uuid, date, uuid) IS
  'The leverantörsreskontra population (live, or as of a date) as one json array of the facts generateSupplierLedger, generateReconciliation and the supplier drill-down read. SECURITY INVOKER.';

REVOKE ALL ON FUNCTION public.get_supplier_ledger_invoices(uuid, date, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_supplier_ledger_invoices(uuid, date, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
