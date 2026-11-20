-- pg-test: covered-by tests/pg/payment-orders-skattekonto.pg.test.ts
-- One open skattekonto payment per execution date instead of per company
-- (crm#1485).
--
-- 20261016180000 allowed one open skattekonto order per company, so a payment
-- signed for one day blocked every other payment to the skattekonto until the
-- bank executed it: preliminary tax could not be paid next to an AGI payment
-- due the same day, and next month's charge could not be prepared ahead. The
-- skattekonto is one OCR number; what Skatteverket sees is the money that
-- arrives per day. This migration:
--   1. replaces the index with one open skattekonto order per company and
--      requested execution date;
--   2. makes create_skattekonto_payment_order() add to the open order of the
--      same day while nobody signed it (draft or approved, not claimed for
--      signing): the amount is summed, an approved order goes back to draft
--      so the total is approved again, and an 'edited' event keeps what was
--      added. A day whose order is claimed for signing or at the bank still
--      refuses with already_in_payment; another day gets its own order.
--
-- The body is 20261016180000 section 4 (the only migration that defines the
-- function) with step 4 (replays) and step 5 (the open order) changed;
-- everything else is unchanged. Existing open orders are at most one per
-- company, so the new index builds on them.

-- ---------------------------------------------------------------------------
-- 1. One open skattekonto order per company and execution date
-- ---------------------------------------------------------------------------
DROP INDEX IF EXISTS public.uq_payment_orders_open_skattekonto_per_company;
CREATE UNIQUE INDEX IF NOT EXISTS uq_payment_orders_open_skattekonto_per_date
  ON public.payment_orders (company_id, requested_execution_date)
  WHERE purpose = 'skattekonto'
    AND status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                   'awaiting_second_signer', 'accepted');

-- ---------------------------------------------------------------------------
-- 2. create_skattekonto_payment_order(): add to the same day's open order
-- ---------------------------------------------------------------------------
-- Returns {ok: true, order} (with merged: {previous_amount, added_amount}
-- when the amount was added to the day's open order) or {ok: false, code,
-- details} with code one of: sandbox, invalid_payload, idempotency_mismatch,
-- already_in_payment.
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
  v_open        public.payment_orders%ROWTYPE;
  v_order       public.payment_orders%ROWTYPE;
  v_constraint  text;
  v_merged_id   uuid;
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
  --    A key that was added to an open order (its 'edited' event keeps the
  --    key) returns that order, so a retried call never adds twice.
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
  SELECT e.payment_order_id INTO v_merged_id
    FROM public.payment_order_events e
   WHERE e.company_id = p_company_id
     AND e.event_type = 'edited'
     AND e.detail ->> 'idempotency_key' = p_idempotency_key
   LIMIT 1;
  IF v_merged_id IS NOT NULL THEN
    SELECT * INTO v_existing FROM public.payment_orders po WHERE po.id = v_merged_id;
    RETURN jsonb_build_object('ok', true, 'order', to_jsonb(v_existing));
  END IF;

  -- 5. One open skattekonto payment per execution date (the index below is
  --    the last word). While nobody signed the day's order (a draft, or
  --    approved and not claimed for signing) the amount is added to it: an
  --    approved order goes back to draft first, so the total is approved
  --    again, and the account and debtor become the ones named now. Claimed
  --    for signing or at the bank, the day's order is in payment.
  SELECT * INTO v_open
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND po.purpose = 'skattekonto'
     AND po.requested_execution_date = p_requested_execution_date
     AND po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                       'awaiting_second_signer', 'accepted')
   ORDER BY po.created_at
   LIMIT 1
   FOR UPDATE;
  IF FOUND THEN
    IF v_open.status NOT IN ('draft', 'approved')
       OR v_open.batch_id IS NOT NULL
       OR v_open.create_started_at IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'already_in_payment',
                                'details', jsonb_build_object('payment_order_id', v_open.id,
                                                              'status', v_open.status,
                                                              'requested_execution_date', v_open.requested_execution_date));
    END IF;
    IF v_open.status = 'approved' THEN
      UPDATE public.payment_orders
         SET status = 'draft', approved_by = NULL, approved_at = NULL
       WHERE id = v_open.id;
      INSERT INTO public.payment_order_events
        (company_id, payment_order_id, event_type, from_status, to_status, actor_user_id, detail)
      VALUES
        (p_company_id, v_open.id, 'unapproved', 'approved', 'draft', v_actor,
         jsonb_build_object('reason', 'amount_added'));
    END IF;
    UPDATE public.payment_orders
       SET amount = round(v_open.amount + round(p_amount, 2), 2),
           cash_account_id = p_cash_account_id,
           debtor_snapshot = p_debtor_snapshot,
           reference = p_reference
     WHERE id = v_open.id
    RETURNING * INTO v_order;
    INSERT INTO public.payment_order_events
      (company_id, payment_order_id, event_type, actor_user_id, detail)
    VALUES
      (p_company_id, v_open.id, 'edited', v_actor,
       jsonb_build_object('reason', 'amount_added',
                          'previous_amount', v_open.amount,
                          'added_amount', round(p_amount, 2),
                          'amount', v_order.amount,
                          'idempotency_key', p_idempotency_key));
    RETURN jsonb_build_object('ok', true, 'order', to_jsonb(v_order),
                              'merged', jsonb_build_object('previous_amount', v_open.amount,
                                                           'added_amount', round(p_amount, 2)));
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
    IF v_constraint = 'uq_payment_orders_open_skattekonto_per_date' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'already_in_payment', 'details', '{}'::jsonb);
    END IF;
    RAISE;
  END;

  RETURN jsonb_build_object('ok', true, 'order', to_jsonb(v_order));
END;
$function$;

REVOKE ALL ON FUNCTION public.create_skattekonto_payment_order(uuid, uuid, jsonb, numeric, date, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_skattekonto_payment_order(uuid, uuid, jsonb, numeric, date, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
