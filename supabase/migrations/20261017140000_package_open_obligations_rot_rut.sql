-- A ROT/RUT begäran whose payout is not booked yet keeps Kundfakturor in
-- use: package_open_obligations names it as open_rot_rut_payout_requests.
--
-- Under fakturamodellen the customer pays their share and Skatteverket pays
-- the rest (BAS 1513) against the begäran om utbetalning, often weeks later.
-- The bank ingest's ROT/RUT matchers (src/lib/invoices/
-- rot-rut-ingest-matchers.ts) match that payout to the begäran. Before this,
-- Kundfakturor read as having nothing open while a begäran was still
-- pending: the "hide an unused package" detector (package_usage, behind
-- SUGGESTIONS_HIDE_UNUSED) could propose hiding it with "inget är öppet
-- där", and once switched off it disappeared instead of winding down, so the
-- payout would arrive with nothing left to match it. The TypeScript probes
-- that decide winding down (src/lib/modules/obligations.ts) name the same
-- obligation.
--
-- Open is exactly the matchers' pool (loadOpenRotRutPayoutRequests,
-- OPEN_ROT_RUT_PAYOUT_STATUSES): status generated, submitted, paid or
-- partially_paid with no settlement voucher. A voucher-less paid begäran is
-- the beslut recorded before the money is booked, so it is still open. A
-- settled (settlement voucher), rejected or cancelled begäran is not.
--
-- Restated from its latest definition (20261016200400) with that one branch
-- added and nothing else changed. package_usage reads it unchanged;
-- set_company_package_choice no longer calls it (20261016230000). The read
-- uses idx_rot_rut_payout_requests_company_status.
--
-- Nothing here touches the bookkeeping: no journal table, no trigger of
-- migration 017.
--
-- pg-test: tests/pg/package-open-obligations-rot-rut.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

CREATE OR REPLACE FUNCTION public.package_open_obligations(p_company_id uuid, p_package_id text)
RETURNS text[]
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT coalesce(array_agg(o.kind ORDER BY o.kind), ARRAY[]::text[])
  FROM (
    -- Bank: a live connection still reads bank lines in.
    SELECT 'active_bank_connection'::text AS kind
     WHERE p_package_id = 'bank'
       AND EXISTS (SELECT 1 FROM public.bank_connections b
                    WHERE b.company_id = p_company_id AND b.status IN ('active', 'pending_selection', 'error'))
    UNION ALL
    -- Kundfakturor: money still owed, invoices still generated, cases still open.
    SELECT 'unpaid_customer_invoices'
     WHERE p_package_id = 'customer-invoices'
       AND EXISTS (SELECT 1 FROM public.invoices i
                    WHERE i.company_id = p_company_id AND i.document_type = 'invoice'
                      AND i.status IN ('sent', 'overdue', 'partially_paid'))
    UNION ALL
    SELECT 'active_recurring_invoices'
     WHERE p_package_id = 'customer-invoices'
       AND EXISTS (SELECT 1 FROM public.recurring_invoice_schedules r
                    WHERE r.company_id = p_company_id AND r.status = 'active')
    UNION ALL
    SELECT 'open_collection_cases'
     WHERE p_package_id = 'customer-invoices'
       AND EXISTS (SELECT 1 FROM public.collection_cases c
                    WHERE c.company_id = p_company_id AND c.is_open)
    UNION ALL
    -- A ROT/RUT begäran whose payout is not booked yet: Skatteverket's share
    -- (1513) is still to arrive and match (20261017140000).
    SELECT 'open_rot_rut_payout_requests'
     WHERE p_package_id = 'customer-invoices'
       AND EXISTS (SELECT 1 FROM public.rot_rut_payout_requests r
                    WHERE r.company_id = p_company_id
                      AND r.status IN ('generated', 'submitted', 'paid', 'partially_paid')
                      AND r.settlement_journal_entry_id IS NULL)
    UNION ALL
    -- Leverantörsfakturor och betalningar: invoices still to pay, payments on their way.
    SELECT 'unpaid_supplier_invoices'
     WHERE p_package_id = 'supplier-invoices-and-payments'
       AND EXISTS (SELECT 1 FROM public.supplier_invoices s
                    WHERE s.company_id = p_company_id AND NOT s.is_credit_note
                      AND s.status IN ('registered', 'approved', 'partially_paid', 'overdue', 'disputed'))
    UNION ALL
    SELECT 'payments_in_flight'
     WHERE p_package_id = 'supplier-invoices-and-payments'
       AND EXISTS (SELECT 1 FROM public.payment_orders p
                    WHERE p.company_id = p_company_id
                      AND p.status IN ('draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'))
    UNION ALL
    -- Kvitton och underlag: underlag not yet handled (the Att göra inbox row's predicate).
    SELECT 'unhandled_documents'
     WHERE p_package_id = 'receipts-and-documents'
       AND EXISTS (SELECT 1 FROM public.invoice_inbox_items i
                    WHERE i.company_id = p_company_id AND i.document_id IS NOT NULL
                      AND i.created_supplier_invoice_id IS NULL AND i.created_journal_entry_id IS NULL
                      AND i.matched_transaction_id IS NULL AND i.routed_to_arkiv_at IS NULL
                      AND NOT EXISTS (SELECT 1 FROM public.document_attachments d
                                       WHERE d.id = i.document_id AND d.journal_entry_id IS NOT NULL))
    UNION ALL
    -- Utlägg: people still to pay back, trips still to book.
    SELECT 'unpaid_expense_claims'
     WHERE p_package_id = 'expenses'
       AND EXISTS (SELECT 1 FROM public.expense_claims e
                    WHERE e.company_id = p_company_id AND e.status = 'registered')
    UNION ALL
    SELECT 'unbooked_mileage'
     WHERE p_package_id = 'expenses'
       AND EXISTS (SELECT 1 FROM public.mileage_trips m
                    WHERE m.company_id = p_company_id AND m.status = 'draft')
    UNION ALL
    -- Lön: people employed, runs not finished, declarations not filed.
    SELECT 'active_employees'
     WHERE p_package_id = 'payroll'
       AND EXISTS (SELECT 1 FROM public.employees e
                    WHERE e.company_id = p_company_id AND e.is_active
                      AND (e.employment_end IS NULL OR e.employment_end >= current_date))
    UNION ALL
    SELECT 'open_salary_runs'
     WHERE p_package_id = 'payroll'
       AND EXISTS (SELECT 1 FROM public.salary_runs r
                    WHERE r.company_id = p_company_id AND r.status IN ('draft', 'review', 'approved', 'paid'))
    UNION ALL
    SELECT 'unfiled_agi'
     WHERE p_package_id = 'payroll'
       AND EXISTS (SELECT 1 FROM public.agi_declarations a
                    WHERE a.company_id = p_company_id AND a.status IN ('generated', 'pending_signature', 'rejected'))
    UNION ALL
    -- Inventarier: an asset still in the register keeps being depreciated.
    SELECT 'active_assets'
     WHERE p_package_id = 'assets'
       AND EXISTS (SELECT 1 FROM public.assets a
                    WHERE a.company_id = p_company_id AND a.disposed_at IS NULL)
    UNION ALL
    -- Kassa och webbshop: connections still reading sales in, days and orders not booked.
    SELECT 'active_pos_connection'
     WHERE p_package_id = 'pos-and-webshop'
       AND EXISTS (SELECT 1 FROM public.pos_connections p
                    WHERE p.company_id = p_company_id AND p.status <> 'disconnected')
    UNION ALL
    SELECT 'unbooked_pos_days'
     WHERE p_package_id = 'pos-and-webshop'
       AND EXISTS (SELECT 1 FROM public.pos_sales_days d
                    WHERE d.company_id = p_company_id AND d.status IN ('ready', 'needs_review'))
    UNION ALL
    SELECT 'active_webshop_connection'
     WHERE p_package_id = 'pos-and-webshop'
       AND (EXISTS (SELECT 1 FROM public.woocommerce_connections w WHERE w.company_id = p_company_id AND w.status <> 'revoked')
         OR EXISTS (SELECT 1 FROM public.shopify_connections s WHERE s.company_id = p_company_id AND s.status <> 'revoked')
         OR EXISTS (SELECT 1 FROM public.zettle_connections z WHERE z.company_id = p_company_id AND z.status <> 'revoked'))
    UNION ALL
    SELECT 'unbooked_webshop_orders'
     WHERE p_package_id = 'pos-and-webshop'
       AND EXISTS (SELECT 1 FROM public.webshop_orders o
                    WHERE o.company_id = p_company_id AND (o.is_paid OR o.row_type = 'refund')
                      AND o.journal_entry_id IS NULL AND o.invoice_id IS NULL AND o.manually_booked_at IS NULL)
    UNION ALL
    -- Anything else (Bokföring, an unknown id) is never free to switch off.
    SELECT 'not_switchable'
     WHERE p_package_id IS NULL
        OR p_package_id NOT IN ('bank', 'customer-invoices', 'supplier-invoices-and-payments', 'receipts-and-documents',
                                'expenses', 'payroll', 'assets', 'pos-and-webshop')
  ) o;
$$;

REVOKE ALL ON FUNCTION public.package_open_obligations(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.package_open_obligations(uuid, text) TO service_role;

NOTIFY pgrst, 'reload schema';
