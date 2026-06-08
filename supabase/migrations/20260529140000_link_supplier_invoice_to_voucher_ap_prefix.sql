-- PR #602 Swedish-compliance fix — broaden AP-account check in
-- link_supplier_invoice_to_voucher to cover the full BAS 2440–2449 range
-- (2440 Leverantörsskulder, 2441 Leverantörsskulder i utländsk valuta,
-- 2443 Skuldfakturor leverantörer, etc.). A samlingsverifikat paying mixed
-- SEK + EUR suppliers will legitimately debit both 2440 and 2441; the
-- earlier hardcode rejected the latter with LINK_SI_VOUCHER_NO_AP_DEBIT
-- even though the booking was BAS-compliant.
--
-- Mirrors the TS-side change in lib/invoices/supplier-voucher-matching.ts
-- where AP_ACCOUNT='2440' became AP_ACCOUNT_PREFIX='244'.

CREATE OR REPLACE FUNCTION public.link_supplier_invoice_to_voucher(
  p_supplier_invoice_id uuid,
  p_journal_entry_id uuid,
  p_user_id uuid,
  p_company_id uuid,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_invoice RECORD;
  v_voucher RECORD;
  v_ap_debit_total numeric := 0;
  v_line_currency text;
  v_remaining numeric;
  v_payment_amount numeric;
  v_new_paid numeric;
  v_new_remaining numeric;
  v_new_status text;
  v_is_fully_paid boolean;
  v_now timestamptz := now();
  v_payment_id uuid;
BEGIN
  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND');
  END IF;

  IF v_invoice.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status));
  END IF;

  v_remaining := COALESCE(v_invoice.remaining_amount, v_invoice.total - COALESCE(v_invoice.paid_amount, 0));
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID');
  END IF;

  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND');
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status));
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT',
      'details', jsonb_build_object('source_type', v_voucher.source_type));
  END IF;

  -- Sum AP debit across the full 244x range (was: account_number = '2440').
  SELECT COALESCE(SUM(debit_amount), 0), MAX(currency)
    INTO v_ap_debit_total, v_line_currency
  FROM public.journal_entry_lines
  WHERE journal_entry_id = p_journal_entry_id
    AND account_number LIKE '244%'
    AND debit_amount > 0;

  v_ap_debit_total := ROUND(v_ap_debit_total * 100) / 100;

  IF v_ap_debit_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT');
  END IF;

  IF COALESCE(v_line_currency, v_invoice.currency) IS DISTINCT FROM v_invoice.currency THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object('invoice_currency', v_invoice.currency, 'line_currency', v_line_currency));
  END IF;

  IF v_ap_debit_total > v_remaining + 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object('ap_debit', v_ap_debit_total, 'remaining', ROUND(v_remaining * 100) / 100));
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND supplier_invoice_id = p_supplier_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_ALREADY_LINKED');
  END IF;

  v_payment_amount := LEAST(v_ap_debit_total, ROUND(v_remaining * 100) / 100);
  v_new_remaining := GREATEST(0, ROUND((v_remaining - v_payment_amount) * 100) / 100);
  v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE 'partially_paid' END;

  UPDATE public.supplier_invoices
  SET status = v_new_status,
      paid_at = CASE WHEN v_is_fully_paid THEN v_now ELSE paid_at END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_supplier_invoice_id;

  INSERT INTO public.supplier_invoice_payments (
    user_id, company_id, supplier_invoice_id, payment_date, amount, currency,
    journal_entry_id, transaction_id, notes
  ) VALUES (
    p_user_id, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice.currency, p_journal_entry_id, NULL, p_notes
  )
  RETURNING id INTO v_payment_id;

  RETURN jsonb_build_object(
    'ok', true,
    'payment_id', v_payment_id,
    'invoice_status', v_new_status,
    'paid_amount', v_new_paid,
    'remaining_amount', v_new_remaining,
    'payment_amount', v_payment_amount,
    'journal_entry_id', p_journal_entry_id,
    'currency', v_invoice.currency
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
