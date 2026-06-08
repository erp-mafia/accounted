-- PR #602 review fix — atomic supplier-invoice voucher linking RPC.
--
-- Closes the race surfaced by greptile review: the TS-side
-- linkSupplierInvoiceToVoucher() updated the supplier_invoices row first, then
-- inserted the supplier_invoice_payments row, with a manual unconditional
-- rollback on insert failure. Under concurrent linking against the same
-- invoice (A starts on `registered`, B completes to `paid`, A's insert fails
-- and the rollback overwrites B's `paid` back to `registered`) the rollback
-- could clobber a sibling's successful write while leaving its payment row
-- in place. This RPC moves both writes into a single Postgres transaction
-- so PG's own rollback handles the failure path correctly.
--
-- Mirrors the existing commit_journal_entry pattern (atomic voucher commit).
-- The TS wrapper now reads the validated invoice + voucher state from the
-- RPC return payload and only emits the `supplier_invoice.paid` event on the
-- happy path.

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
  -- 1. Lock invoice for the duration of this transaction. FOR UPDATE so a
  --    concurrent linker has to wait until we commit (or roll back).
  SELECT * INTO v_invoice
  FROM public.supplier_invoices
  WHERE id = p_supplier_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND');
  END IF;

  IF v_invoice.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status)
    );
  END IF;

  -- Trust the stored remaining_amount when present (even when 0), only fall
  -- through to total - paid_amount when the column is NULL. The "> 0" guard
  -- was the original sin from voucher-matching.ts; rounding drift on a
  -- fully-paid invoice persisted as remaining_amount=0 could compute a
  -- residual via total - paid_amount and slip past the FULLY_PAID guard.
  v_remaining := COALESCE(v_invoice.remaining_amount,
                          v_invoice.total - COALESCE(v_invoice.paid_amount, 0));
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_FULLY_PAID');
  END IF;

  -- 2. Resolve the voucher
  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_VOUCHER_NOT_FOUND');
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status)
    );
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT',
      'details', jsonb_build_object('source_type', v_voucher.source_type)
    );
  END IF;

  -- 3. Sum AP debit on 2440 across all lines in this voucher.
  SELECT COALESCE(SUM(debit_amount), 0), MAX(currency)
    INTO v_ap_debit_total, v_line_currency
  FROM public.journal_entry_lines
  WHERE journal_entry_id = p_journal_entry_id
    AND account_number = '2440'
    AND debit_amount > 0;

  v_ap_debit_total := ROUND(v_ap_debit_total * 100) / 100;

  IF v_ap_debit_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_NO_AP_DEBIT');
  END IF;

  IF COALESCE(v_line_currency, v_invoice.currency) IS DISTINCT FROM v_invoice.currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'line_currency', v_line_currency
      )
    );
  END IF;

  IF v_ap_debit_total > v_remaining + 0.005 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object(
        'ap_debit', v_ap_debit_total,
        'remaining', ROUND(v_remaining * 100) / 100
      )
    );
  END IF;

  -- 4. Reject re-link of the same voucher to the same invoice.
  IF EXISTS (
    SELECT 1 FROM public.supplier_invoice_payments
    WHERE company_id = p_company_id
      AND supplier_invoice_id = p_supplier_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_ALREADY_LINKED');
  END IF;

  -- 5. Compute the advance.
  v_payment_amount := LEAST(v_ap_debit_total, ROUND(v_remaining * 100) / 100);
  v_new_remaining := GREATEST(0,
    ROUND((v_remaining - v_payment_amount) * 100) / 100
  );
  v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE 'partially_paid' END;

  -- 6. Apply both writes. The RPC body is one transaction; a failure on the
  --    INSERT triggers PG's own rollback of the UPDATE — no manual rollback
  --    path needed.
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

COMMENT ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Atomically link an existing posted verifikat as payment for a supplier invoice. Locks the invoice row, validates the voucher debits 2440, advances paid_amount/remaining_amount/status, and inserts a supplier_invoice_payments row in one PG transaction. Returns jsonb { ok, ..., payment_id } on success or { ok: false, code, details } on guard failure.';

NOTIFY pgrst, 'reload schema';
