-- Service-only invariant check for the customer AR sub-ledger (#2019): a paid
-- or partially paid customer invoice whose posted payment voucher
-- (invoice_paid / invoice_cash_payment) has no invoice_payments row. The
-- kontantmetod bokslut cut-off reads invoice_payments only, so such an invoice
-- is booked as a fordran with vilande moms at year end and its revenue and
-- VAT count twice. The weekly invariants cron reports a non-zero count.
-- Sandbox companies are left out: their books are demo data.
-- pg-test: tests/pg/invoice-payment-row-invariant.pg.test.ts
CREATE FUNCTION public.check_invoice_payment_row_invariant() RETURNS jsonb
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public SET statement_timeout = '30s' AS $$
  WITH missing AS (
    SELECT DISTINCT i.id, i.company_id
    FROM public.journal_entries je
    JOIN public.invoices i ON i.id = je.source_id AND i.company_id = je.company_id
    LEFT JOIN public.company_settings cs ON cs.company_id = i.company_id
    WHERE je.source_type IN ('invoice_paid', 'invoice_cash_payment')
      AND je.status = 'posted'
      AND i.status IN ('paid', 'partially_paid')
      AND coalesce(i.document_type, 'invoice') = 'invoice'
      AND i.paid_amount > 0
      AND NOT coalesce(cs.is_sandbox, false)
      AND NOT EXISTS (SELECT 1 FROM public.invoice_payments p WHERE p.invoice_id = i.id)
  ) SELECT jsonb_build_object(
    'missing_payment_rows', (SELECT count(*) FROM missing),
    'companies', (SELECT count(DISTINCT company_id) FROM missing),
    'sample_invoice_ids', (SELECT coalesce(jsonb_agg(s.id), '[]'::jsonb)
      FROM (SELECT id FROM missing ORDER BY id LIMIT 20) s)
  );
$$;
REVOKE ALL ON FUNCTION public.check_invoice_payment_row_invariant() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_invoice_payment_row_invariant() TO service_role;
