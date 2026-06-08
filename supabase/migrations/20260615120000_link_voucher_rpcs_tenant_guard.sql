-- Tenant guard for the voucher-link write RPCs (PR #666 review follow-up,
-- OWASP ASVS V8.2.1 / audit A5 direction).
--
-- link_invoice_to_voucher (20260614120000) and link_supplier_invoice_to_voucher
-- (20260529130000/140000) are SECURITY DEFINER and EXECUTE-able by
-- `authenticated`, so any signed-in user could call them via PostgREST with
-- ANOTHER company's p_company_id and mutate that tenant's invoices + payment
-- rows. PR #625 closed the same hole on the GL read RPCs; this applies the
-- identical claims-based guard to both write RPCs: anon/authenticated callers
-- must be a member of p_company_id (user_company_ids()), while service_role and
-- direct/superuser access (no JWT role — migrations, pg-real harness, MCP /
-- API-key paths whose company scoping happens in TS) bypass.
--
-- Guard failures return the existing *_INVOICE_NOT_FOUND codes so a probing
-- caller cannot distinguish "wrong tenant" from "no such invoice".
--
-- Also hardens p_notes with the same 2000-char cap the Zod layer
-- (LinkInvoiceToVoucherSchema / LinkSupplierInvoiceToVoucherSchema) enforces on
-- the API path — direct PostgREST callers could otherwise insert unbounded text.
--
-- And pins payment-row attribution (GDPR Art. 32): for user-session callers the
-- JWT sub is authoritative for invoice_payments.user_id — a direct PostgREST
-- caller could otherwise attribute financial records to an arbitrary user via
-- p_user_id. service_role / direct callers keep p_user_id verbatim (their
-- company + user scoping happens in the TS layer).
--
-- Both function bodies are otherwise identical to their previous versions.

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
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
BEGIN
  -- 0. Tenant guard (mirrors 20260611140000): anon/authenticated may only act
  --    on their own companies; service_role / direct access bypasses.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id NOT IN (SELECT public.user_company_ids()) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_VOUCHER_INVOICE_NOT_FOUND');
    END IF;
    -- Attribution: the JWT sub is authoritative for user-session callers —
    -- p_user_id cannot point the payment row at someone else.
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_VOUCHER_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

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
    v_acting_user, p_company_id, p_invoice_id, v_voucher.entry_date,
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
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_acting_user uuid := p_user_id;
BEGIN
  -- Tenant guard (mirrors 20260611140000): anon/authenticated may only act on
  -- their own companies; service_role / direct access bypasses.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF p_company_id NOT IN (SELECT public.user_company_ids()) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'LINK_SI_VOUCHER_INVOICE_NOT_FOUND');
    END IF;
    -- Attribution: the JWT sub is authoritative for user-session callers —
    -- p_user_id cannot point the payment row at someone else.
    v_acting_user := coalesce(
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid,
      p_user_id
    );
  END IF;

  IF p_notes IS NOT NULL AND char_length(p_notes) > 2000 THEN
    RETURN jsonb_build_object(
      'ok', false,
      'code', 'LINK_SI_VOUCHER_NOTES_TOO_LONG',
      'details', jsonb_build_object('max_length', 2000, 'length', char_length(p_notes))
    );
  END IF;

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
    v_acting_user, p_company_id, p_supplier_invoice_id, v_voucher.entry_date,
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

-- The supplier RPC predates the write-RPC grant hardening and still carried the
-- Postgres default (EXECUTE to PUBLIC). Align it with link_invoice_to_voucher:
-- `authenticated` covers user-session clients; `service_role` covers the MCP /
-- API-key paths (createServiceClientNoCookies).
REVOKE ALL ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.link_supplier_invoice_to_voucher(uuid, uuid, uuid, uuid, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
