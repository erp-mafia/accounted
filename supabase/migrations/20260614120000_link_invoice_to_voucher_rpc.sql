-- Audit C2 fix — atomic customer-invoice voucher linking RPC.
--
-- Mirrors link_supplier_invoice_to_voucher (PR #602, migrations
-- 20260529130000 + 20260529140000): the TS-side linkInvoiceToVoucher()
-- updated the invoices row first, then inserted the invoice_payments row,
-- with a manual rollback that restored from a STALE pre-link snapshot. Under
-- concurrent linking against the same invoice (A starts on `sent`, B
-- completes to `paid`, A's insert fails and A's rollback overwrites B's
-- `paid` back to `sent`) the rollback could clobber a sibling's successful
-- write while leaving its payment row in place. This RPC moves validation +
-- both writes into a single Postgres transaction with the invoice row locked
-- FOR UPDATE, so concurrent linkers serialize and PG's own rollback handles
-- the failure path.
--
-- Also inherits the supplier RPC's remaining-amount fix: trust the stored
-- remaining_amount whenever it is non-NULL (even 0) and only fall back to
-- total - paid_amount when NULL. The TS computeRemaining()'s "> 0" guard let
-- rounding drift on a fully-paid invoice slip past the FULLY_PAID check.
--
-- AR matching mirrors lib/invoices/voucher-matching.ts: credit lines on the
-- 151x range (AR_ACCOUNT_PREFIX '151' — 1510 Kundfordringar et al). Error
-- codes are the existing LINK_VOUCHER_* set so callers map unchanged.

CREATE OR REPLACE FUNCTION public.link_invoice_to_voucher(
  p_invoice_id uuid,
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
  v_ar_credit_total numeric := 0;
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
  -- 1. Lock the invoice for the duration of this transaction. FOR UPDATE so a
  --    concurrent linker has to wait until we commit (or roll back).
  SELECT * INTO v_invoice
  FROM public.invoices
  WHERE id = p_invoice_id AND company_id = p_company_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_NOT_FOUND');
  END IF;

  IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_INVOICE_FULLY_PAID',
      'details', jsonb_build_object('status', v_invoice.status)
    );
  END IF;

  v_remaining := COALESCE(v_invoice.remaining_amount,
                          v_invoice.total - COALESCE(v_invoice.paid_amount, 0));
  IF v_remaining <= 0.005 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_FULLY_PAID');
  END IF;

  -- 2. Resolve the voucher.
  SELECT * INTO v_voucher
  FROM public.journal_entries
  WHERE id = p_journal_entry_id AND company_id = p_company_id;

  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_VOUCHER_NOT_FOUND');
  END IF;

  IF v_voucher.status <> 'posted' THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NOT_POSTED',
      'details', jsonb_build_object('status', v_voucher.status)
    );
  END IF;

  IF v_voucher.source_type IN ('opening_balance', 'storno') THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NO_AR_CREDIT',
      'details', jsonb_build_object('source_type', v_voucher.source_type)
    );
  END IF;

  -- 3. Sum AR credit across the voucher's 151x lines.
  SELECT COALESCE(SUM(credit_amount), 0), MAX(currency)
    INTO v_ar_credit_total, v_line_currency
  FROM public.journal_entry_lines
  WHERE journal_entry_id = p_journal_entry_id
    AND account_number LIKE '151%'
    AND credit_amount > 0;

  v_ar_credit_total := ROUND(v_ar_credit_total * 100) / 100;

  IF v_ar_credit_total <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_NO_AR_CREDIT');
  END IF;

  IF COALESCE(v_line_currency, v_invoice.currency) IS DISTINCT FROM v_invoice.currency THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_CURRENCY_MISMATCH',
      'details', jsonb_build_object(
        'invoice_currency', v_invoice.currency,
        'line_currency', v_line_currency
      )
    );
  END IF;

  IF v_ar_credit_total > v_remaining + 0.005 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object(
        'ar_credit', v_ar_credit_total,
        'remaining', ROUND(v_remaining * 100) / 100
      )
    );
  END IF;

  -- 4. Reject re-link of the same voucher to the same invoice. Authoritative
  --    under the FOR UPDATE lock; the partial unique index
  --    idx_invoice_payments_je_inv_unique stays as the last line of defence
  --    for non-RPC writers.
  IF EXISTS (
    SELECT 1 FROM public.invoice_payments
    WHERE company_id = p_company_id
      AND invoice_id = p_invoice_id
      AND journal_entry_id = p_journal_entry_id
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_ALREADY_LINKED');
  END IF;

  -- 5. Compute the advance.
  v_payment_amount := LEAST(v_ar_credit_total, ROUND(v_remaining * 100) / 100);
  v_new_remaining := GREATEST(0,
    ROUND((v_remaining - v_payment_amount) * 100) / 100
  );
  v_new_paid := ROUND((COALESCE(v_invoice.paid_amount, 0) + v_payment_amount) * 100) / 100;
  v_is_fully_paid := v_new_remaining <= 0.005;
  v_new_status := CASE WHEN v_is_fully_paid THEN 'paid' ELSE 'partially_paid' END;

  -- 6. Apply both writes. The RPC body is one transaction; a failure on the
  --    INSERT triggers PG's own rollback of the UPDATE — no manual rollback
  --    path needed.
  UPDATE public.invoices
  SET status = v_new_status,
      paid_at = CASE WHEN v_is_fully_paid THEN v_now ELSE paid_at END,
      paid_amount = v_new_paid,
      remaining_amount = v_new_remaining,
      updated_at = v_now
  WHERE id = p_invoice_id;

  INSERT INTO public.invoice_payments (
    user_id, company_id, invoice_id, payment_date, amount, currency,
    exchange_rate, journal_entry_id, transaction_id, notes
  ) VALUES (
    p_user_id, p_company_id, p_invoice_id, v_voucher.entry_date,
    v_payment_amount, v_invoice.currency, v_invoice.exchange_rate,
    p_journal_entry_id, NULL, p_notes
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
    'currency', v_invoice.currency,
    'payment_date', v_voucher.entry_date
  );
END;
$$;

-- Write-RPC hardening (audit A5 direction — PR #625 guarded the read RPCs):
-- never callable anonymously. `authenticated` covers user-session clients;
-- `service_role` covers the MCP / API-key paths (createServiceClientNoCookies).
REVOKE ALL ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

COMMENT ON FUNCTION public.link_invoice_to_voucher(uuid, uuid, uuid, uuid, text) IS
  'Atomically link an existing posted verifikat as payment for a customer invoice. Locks the invoice row, validates the voucher credits 151x, advances paid_amount/remaining_amount/status, and inserts an invoice_payments row in one PG transaction. Returns jsonb { ok, ..., payment_id } on success or { ok: false, code, details } on guard failure.';

NOTIFY pgrst, 'reload schema';
