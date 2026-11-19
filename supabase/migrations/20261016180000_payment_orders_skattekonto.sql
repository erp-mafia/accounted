-- pg-test: covered-by tests/pg/payment-orders-skattekonto.pg.test.ts
-- Paying the skattekonto through the bank: what Skatteverket will draw, paid
-- in from the company's own account and signed with BankID like a supplier
-- payment.
--
-- payment_orders.purpose was 'supplier_invoice' only (20261010090000, whose
-- header foresaw tax payouts widening the CHECK). A skattekonto payment has no
-- invoice and no supplier: it always goes to Skatteverket's bankgiro
-- 5050-1055 with the company's OCR number, so nothing about the payee is the
-- caller's choice and no account needs a person's confirmation. This
-- migration:
--   1. widens purpose with 'skattekonto' and payee_source with 'skatteverket';
--   2. pins what a skattekonto order is: no supplier invoice, bankgiro
--      50501055, an OCR reference of digits only, payee source skatteverket,
--      SEK; and the payee source skatteverket belongs to such an order alone;
--   3. allows one open skattekonto order per company (draft through accepted
--      at the bank), the "one payment at a time" rule an invoice has;
--   4. adds create_skattekonto_payment_order(), the one way to create one,
--      with the guards of create_payment_orders (actor, write role, sandbox,
--      idempotent replay) and its 'created' event; the payee is set here,
--      never taken from the caller;
--   5. lets release_payment_order() send a skattekonto order back to
--      approved: it cancelled every order without an invoice as
--      invoice_missing.
--
-- claim_payment_orders_for_signing and rebatch_payment_orders_for_signing
-- stay as they are: their re-check of the invoice joins supplier_invoices,
-- so an order without one passes it untouched (the pg test claims one). The
-- settlement stays with supplier invoices: nothing books or matches the debit
-- of a skattekonto payment in v1, and the bank row is booked the normal way
-- (the skattekonto account against the bank account).
--
-- Existing rows are all supplier_invoice orders, which every new CHECK
-- accepts: each is added NOT VALID and validated in the same migration.

-- ---------------------------------------------------------------------------
-- 1. Purpose and payee source
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_purpose_check;
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_purpose_check
  CHECK (purpose IN ('supplier_invoice', 'skattekonto')) NOT VALID;
ALTER TABLE public.payment_orders
  VALIDATE CONSTRAINT payment_orders_purpose_check;

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_payee_source_check;
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_payee_source_check
  CHECK (payee_source IN ('invoice', 'supplier', 'skatteverket')) NOT VALID;
ALTER TABLE public.payment_orders
  VALIDATE CONSTRAINT payment_orders_payee_source_check;

-- ---------------------------------------------------------------------------
-- 2. What a skattekonto order is
-- ---------------------------------------------------------------------------
-- Every column read here is NOT NULL except supplier_invoice_id (tested with
-- IS NULL) and payee_bankgiro (coalesced), so the CASE is never NULL: a NULL
-- would pass a CHECK.
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_skattekonto_instruction CHECK (
    CASE WHEN purpose = 'skattekonto' THEN
      supplier_invoice_id IS NULL
      AND payee_type = 'bankgiro'
      AND coalesce(payee_bankgiro, '') = '50501055'
      AND reference_type = 'ocr'
      AND reference ~ '^[0-9]+$'
      AND payee_source = 'skatteverket'
      AND currency = 'SEK'
    ELSE payee_source <> 'skatteverket'
    END
  ) NOT VALID;
ALTER TABLE public.payment_orders
  VALIDATE CONSTRAINT payment_orders_skattekonto_instruction;

-- ---------------------------------------------------------------------------
-- 3. One open skattekonto order per company
-- ---------------------------------------------------------------------------
-- Open: from the draft until the bank has accepted it. An executed one is
-- closed at once: no settlement follows it in v1, and the next sync of the
-- skattekonto shows the money arrived. A second order while one is open would
-- pay the same charge twice.
CREATE UNIQUE INDEX uq_payment_orders_open_skattekonto_per_company
  ON public.payment_orders (company_id)
  WHERE purpose = 'skattekonto'
    AND status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                   'awaiting_second_signer', 'accepted');

-- ---------------------------------------------------------------------------
-- 4. create_skattekonto_payment_order(): the one way to create one
-- ---------------------------------------------------------------------------
-- The caller names the account the money leaves from (with its debtor
-- snapshot, as create_payment_orders takes it), the amount, the execution
-- date, the OCR number and an idempotency key. The payee is Skatteverket's
-- bankgiro, set here; payee_check is 'known' because the account is the one
-- Skatteverket publishes for every skattekonto, never one an invoice or a
-- supplier card could change. The order is created as a draft. An
-- idempotency key already used in the company returns its order, for a
-- skattekonto order only.
--
-- Returns {ok: true, order} or {ok: false, code, details} with code one of:
-- sandbox, invalid_payload, idempotency_mismatch, already_in_payment.
CREATE OR REPLACE FUNCTION public.create_skattekonto_payment_order(
  p_company_id               uuid,
  p_cash_account_id          uuid,
  p_debtor_snapshot          jsonb,
  p_amount                   numeric,
  p_requested_execution_date date,
  p_reference                text,
  p_idempotency_key          text,
  p_user_id                  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor       uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role text;
  v_existing    public.payment_orders%ROWTYPE;
  v_open        uuid;
  v_order       public.payment_orders%ROWTYPE;
  v_constraint  text;
BEGIN
  -- 1. Actor + tenant guard (the shape of create_payment_orders). Only the
  --    service role holds EXECUTE; the session branch stays as defence in
  --    depth.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    v_actor := auth.uid();
  END IF;
  IF v_actor IS NULL THEN
    RAISE EXCEPTION 'unauthorized: no actor' USING ERRCODE = '42501';
  END IF;
  SELECT cm.role INTO v_caller_role
    FROM public.company_members cm
   WHERE cm.company_id = p_company_id AND cm.user_id = v_actor;
  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin', 'member') THEN
    RAISE EXCEPTION 'unauthorized: caller has no write role in company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  -- Never in a sandbox company: the service refuses first
  -- (lib/payments/orders/prepare-skattekonto.ts), and the sandbox teardown
  -- refuses on purpose to unwind a payment order.
  IF EXISTS (SELECT 1 FROM public.company_settings cs WHERE cs.company_id = p_company_id AND cs.is_sandbox) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sandbox', 'details', 'bank payments are not available in a sandbox company');
  END IF;

  -- 2. Payload. The table's CHECKs hold the rest (the debtor's account in
  --    the same company through the composite FK).
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
     OR p_cash_account_id IS NULL
     OR p_requested_execution_date IS NULL
     OR jsonb_typeof(p_debtor_snapshot) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload',
                              'details', 'cash account, debtor, execution date and idempotency_key are required');
  END IF;
  IF p_amount IS NULL OR round(p_amount, 2) <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload', 'details', 'the amount must be above zero');
  END IF;
  IF p_reference IS NULL OR p_reference !~ '^[0-9]{2,25}$' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload', 'details', 'the reference is the OCR number, digits only');
  END IF;

  -- 3. One create per company at a time: there is no invoice row to lock,
  --    so concurrent creates queue on the company's key instead of racing
  --    past the checks below.
  PERFORM pg_advisory_xact_lock(hashtextextended('skattekonto-payment-order:' || p_company_id::text, 0));

  -- 4. Replays: an existing idempotency_key returns its order, but only a
  --    skattekonto order; a key used for a supplier payment is a caller bug.
  SELECT * INTO v_existing
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.idempotency_key = p_idempotency_key;
  IF FOUND THEN
    IF v_existing.purpose IS DISTINCT FROM 'skattekonto' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'idempotency_mismatch',
                                'details', jsonb_build_object('idempotency_key', p_idempotency_key,
                                                              'payment_order_id', v_existing.id));
    END IF;
    RETURN jsonb_build_object('ok', true, 'order', to_jsonb(v_existing));
  END IF;

  -- 5. One open skattekonto payment per company (the index below is the
  --    last word): the service replaces a draft nobody approved before it
  --    calls here, so what is left is in payment.
  SELECT po.id INTO v_open
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND po.purpose = 'skattekonto'
     AND po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                       'awaiting_second_signer', 'accepted')
   ORDER BY po.created_at
   LIMIT 1;
  IF v_open IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'already_in_payment',
                              'details', jsonb_build_object('payment_order_id', v_open));
  END IF;

  -- 6. Insert, with its event. A race the lock above did not see ends in a
  --    clean refusal, not an error.
  BEGIN
    INSERT INTO public.payment_orders (
      company_id, user_id, purpose, supplier_invoice_id, status,
      amount, currency, requested_execution_date, cash_account_id, debtor_snapshot,
      payee_type, payee_bankgiro, payee_name, payee_source, payee_check,
      reference_type, reference, idempotency_key)
    VALUES (
      p_company_id, v_actor, 'skattekonto', NULL, 'draft',
      round(p_amount, 2), 'SEK', p_requested_execution_date, p_cash_account_id, p_debtor_snapshot,
      'bankgiro', '50501055', 'Skatteverket', 'skatteverket', 'known',
      'ocr', p_reference, p_idempotency_key)
    RETURNING * INTO v_order;

    INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, to_status, actor_user_id)
    VALUES (p_company_id, v_order.id, 'created', 'draft', v_actor);
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'uq_payment_orders_open_skattekonto_per_company' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'already_in_payment', 'details', '{}'::jsonb);
    END IF;
    RAISE;
  END;

  RETURN jsonb_build_object('ok', true, 'order', to_jsonb(v_order));
END;
$function$;

REVOKE ALL ON FUNCTION public.create_skattekonto_payment_order(uuid, uuid, jsonb, numeric, date, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_skattekonto_payment_order(uuid, uuid, jsonb, numeric, date, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 5. release_payment_order(): a skattekonto order goes back to approved
-- ---------------------------------------------------------------------------
-- The body of 20261010090000 section 12, with one change: an order that pays
-- no invoice (a skattekonto payment) has no invoice that could close under
-- it, so it goes back to approved to be signed again instead of being
-- cancelled as invoice_missing. Everything else, the supplier invoice path
-- included, is unchanged.
--
-- The one way a claimed order leaves its signing because the bank holds
-- nothing for it (rule 2): its create failed before reaching the bank or
-- never started, or its payment was cancelled at the bank and the cancel
-- confirmed (p_provider_payment_id names that payment). The confirmed cancel
-- is recorded (provider_cancelled) in the same transaction as the release,
-- so one is never kept without the other. The order goes back to approved,
-- to be signed again, unless its invoice no longer needs paying: then it is
-- cancelled. Each step is one the lifecycle trigger allows
-- (awaiting_signature -> submitted -> approved -> cancelled).
--
-- p_error_code is the bank's answer to a create that never reached it, and
-- is required while that create's write-ahead marker is set (rule 1).
--
-- Returns {ok: true, status: 'approved' | 'cancelled'} or {ok: false, code}
-- with code 'moved' (the order is no longer where the caller saw it) or
-- 'create_in_progress'.
CREATE OR REPLACE FUNCTION public.release_payment_order(
  p_company_id          uuid,
  p_order_id            uuid,
  p_batch_id            uuid,
  p_provider_payment_id text,
  p_provider_status     text,
  p_reason              text,
  p_error_code          text DEFAULT NULL,
  p_user_id             uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_order    public.payment_orders%ROWTYPE;
  v_invoice  public.supplier_invoices%ROWTYPE;
  v_reason   text;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'unauthorized: payment orders are released by the server only' USING ERRCODE = '42501';
  END IF;

  -- The invoice before the order (the claim's lock order).
  SELECT si.* INTO v_invoice
    FROM public.supplier_invoices si
   WHERE si.company_id = p_company_id
     AND si.id = (SELECT po.supplier_invoice_id FROM public.payment_orders po
                   WHERE po.id = p_order_id AND po.company_id = p_company_id)
     FOR UPDATE;
  SELECT * INTO v_order
    FROM public.payment_orders po
   WHERE po.id = p_order_id AND po.company_id = p_company_id
     FOR UPDATE;
  IF NOT FOUND
     OR v_order.batch_id IS DISTINCT FROM p_batch_id
     OR v_order.status NOT IN ('submitted', 'awaiting_signature')
     OR v_order.provider_payment_id IS DISTINCT FROM p_provider_payment_id
     OR v_order.outcome_unknown_at IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'moved');
  END IF;
  IF v_order.create_started_at IS NOT NULL AND p_error_code IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_in_progress');
  END IF;

  IF p_provider_payment_id IS NOT NULL THEN
    INSERT INTO public.payment_order_events
      (company_id, payment_order_id, batch_id, event_type, provider_status, actor_user_id, detail)
    VALUES
      (p_company_id, p_order_id, p_batch_id, 'provider_cancelled', p_provider_status, p_user_id,
       jsonb_build_object('provider_payment_id', p_provider_payment_id, 'reason', p_reason));
  END IF;

  IF v_order.status = 'awaiting_signature' THEN
    UPDATE public.payment_orders SET status = 'submitted' WHERE id = p_order_id;
  END IF;
  UPDATE public.payment_orders
     SET status = 'approved',
         batch_id = NULL,
         provider_payment_id = NULL,
         provider_payment_product = NULL,
         provider_status = coalesce(p_provider_status, provider_status),
         provider_status_at = CASE WHEN p_provider_status IS NOT NULL THEN now() ELSE provider_status_at END,
         provider_error_code = coalesce(p_error_code, provider_error_code),
         create_started_at = NULL
   WHERE id = p_order_id;
  INSERT INTO public.payment_order_events
    (company_id, payment_order_id, batch_id, event_type, from_status, to_status, actor_user_id, detail)
  VALUES
    (p_company_id, p_order_id, p_batch_id, 'released', 'submitted', 'approved', p_user_id,
     jsonb_strip_nulls(jsonb_build_object('reason', p_reason, 'code', p_error_code,
                                          'cancelled_payment_id', p_provider_payment_id)));

  -- Rule 2: nothing left to pay means nothing left to sign. An order that
  -- pays no invoice (skattekonto) has nothing that closes under it.
  v_reason := CASE
    WHEN v_order.purpose <> 'supplier_invoice' THEN NULL
    WHEN v_invoice.id IS NULL THEN 'invoice_missing'
    WHEN v_invoice.is_credit_note THEN 'invoice_credit_note'
    WHEN v_invoice.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue') THEN 'invoice_' || v_invoice.status
    WHEN v_order.amount > v_invoice.remaining_amount + 0.005 THEN 'amount_exceeds_remaining'
  END;
  IF v_reason IS NOT NULL THEN
    UPDATE public.payment_orders
       SET status = 'cancelled',
           cancelled_at = now(),
           cancelled_by = p_user_id
     WHERE id = p_order_id;
    INSERT INTO public.payment_order_events
      (company_id, payment_order_id, event_type, from_status, to_status, actor_user_id, detail)
    VALUES
      (p_company_id, p_order_id, 'cancelled', 'approved', 'cancelled', p_user_id,
       jsonb_build_object('reason', v_reason));
    RETURN jsonb_build_object('ok', true, 'status', 'cancelled');
  END IF;
  RETURN jsonb_build_object('ok', true, 'status', 'approved');
END;
$function$;

REVOKE ALL ON FUNCTION public.release_payment_order(uuid, uuid, uuid, text, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.release_payment_order(uuid, uuid, uuid, text, text, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
