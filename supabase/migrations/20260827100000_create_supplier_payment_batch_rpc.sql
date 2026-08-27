-- create_supplier_payment_batch: the single write path for supplier payment
-- batch (betalfil) creation. Closes #1503.
--
-- Before this RPC, createSupplierPaymentBatch wrote the batch header and its
-- items as two separate PostgREST inserts, and the active-batch recheck ran
-- app-side before either. Two failure modes followed:
--
--   1. Race: two concurrent creates selecting the same invoice could both pass
--      the app-side active-batch check and both land an active batch without
--      confirm_already_batched, so the same invoice could be handed to the
--      bank twice.
--   2. Empty header: if the item insert failed after the header landed, the
--      best-effort cancel of the header could itself fail, leaving an empty
--      'created' batch behind (inert, because the file route refuses it, but
--      wrong in history).
--
-- This function is the authority. TypeScript keeps the eligibility, amount
-- and date evaluation (shared with the preview so nothing is created that the
-- preview would not show) and the minting of the batch id + pain.001 MsgId
-- (MsgId derives from the branded app name, a TS-only white-label concept).
-- The RPC then, inside ONE transaction:
--
--   a. locks the selected supplier_invoices FOR UPDATE, in id order so two
--      overlapping concurrent creates queue instead of deadlocking;
--   b. re-checks the invoices under the lock (still present, still payable,
--      amount still within remaining), reusing the service's result codes;
--   c. re-checks active batches AFTER the lock unless the caller confirmed
--      already-batched invoices: under READ COMMITTED a creator that waited on
--      the lock sees the winner's committed items here, which is the recheck
--      the app-side pre-check cannot provide;
--   d. inserts header + items. Totals are computed from the items so header
--      and rows can never disagree, and a constraint violation on either
--      table (payee_fields_match, uq_supplier_payment_batch_invoice, the
--      composite company FKs, the CHECKs) aborts the whole call: the header
--      can no longer outlive its items.
--
-- Domain refusals return jsonb {ok:false, code, details} in the
-- match_batch_allocate shape: no write precedes them, so nothing needs
-- rolling back and the service maps them onto its existing result union.
-- The tenant guard RAISEs 42501 (detach_underlag_duplicate shape): JWT callers
-- must be members of p_company_id and always act as auth.uid(); p_user_id is
-- honored only for service-role callers, which authenticate the user
-- application-side. The guard parses request.jwt.claims directly rather than
-- calling auth.role(): the CI auth shim leaves auth.role() NULL under a
-- claims-only session.
--
-- The write_audit_log triggers on both tables fire as before; the RLS insert
-- policies are bypassed by SECURITY DEFINER, which is why the membership guard
-- above is mandatory.

CREATE OR REPLACE FUNCTION public.create_supplier_payment_batch(
  p_company_id               uuid,
  p_batch_id                 uuid,
  p_format                   text,
  p_msg_id                   text,
  p_debtor_snapshot          jsonb,
  p_items                    jsonb,
  p_confirm_already_batched  boolean DEFAULT false,
  p_user_id                  uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role     text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor        uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role  text;
  v_ids          uuid[];
  v_missing      jsonb;
  v_not_payable  jsonb;
  v_excessive    jsonb;
  v_already      jsonb;
  v_total        numeric;
  v_count        integer;
  v_batch        public.supplier_payment_batches%ROWTYPE;
BEGIN
  -- 1. Actor + tenant guard.
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    IF NOT public.caller_is_company_member(p_company_id) THEN
      RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
        USING ERRCODE = '42501';
    END IF;
    -- A JWT caller can never act as someone else: p_user_id is only for
    -- service-role paths, which authenticate the user application-side.
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

  -- 2. Payload shape.
  IF p_batch_id IS NULL OR p_msg_id IS NULL OR p_debtor_snapshot IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_failed', 'details', 'missing header fields');
  END IF;
  IF jsonb_typeof(p_items) IS DISTINCT FROM 'array' OR jsonb_array_length(p_items) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_failed', 'details', 'no items');
  END IF;
  IF p_format NOT IN ('pain001', 'bg_lb') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_failed', 'details', 'unsupported format');
  END IF;

  SELECT array_agg((x ->> 'supplier_invoice_id')::uuid)
    INTO v_ids
    FROM jsonb_array_elements(p_items) AS x;

  -- 3. Lock the invoices in id order. Two concurrent creates with overlapping
  --    invoice sets queue on the first shared row instead of deadlocking, and
  --    the loser proceeds only after the winner has committed or rolled back.
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.company_id = p_company_id AND si.id = ANY(v_ids)
    ORDER BY si.id
    FOR UPDATE;

  -- 4. Defense-in-depth rechecks under the lock. TypeScript already evaluated
  --    every invoice; these close the "changed meanwhile" window. The payable
  --    status list must match PAYABLE_SUPPLIER_INVOICE_STATUSES in
  --    lib/payments/batch-eligibility.ts.
  SELECT jsonb_agg(jsonb_build_object('id', x.id, 'reason', 'not_found'))
    INTO v_missing
    FROM unnest(v_ids) AS x(id)
   WHERE NOT EXISTS (
     SELECT 1 FROM public.supplier_invoices si
      WHERE si.id = x.id AND si.company_id = p_company_id
   );
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ineligible', 'details', v_missing);
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'id', si.id,
           'reason', CASE WHEN si.is_credit_note THEN 'credit_note' ELSE 'not_payable' END))
    INTO v_not_payable
    FROM public.supplier_invoices si
   WHERE si.company_id = p_company_id
     AND si.id = ANY(v_ids)
     AND (si.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue')
          OR si.is_credit_note);
  IF v_not_payable IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ineligible', 'details', v_not_payable);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', si.id))
    INTO v_excessive
    FROM jsonb_array_elements(p_items) AS x
    JOIN public.supplier_invoices si
      ON si.id = (x ->> 'supplier_invoice_id')::uuid AND si.company_id = p_company_id
   WHERE (x ->> 'amount')::numeric > si.remaining_amount + 0.005;
  IF v_excessive IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'amount_exceeds_remaining', 'details', v_excessive);
  END IF;

  -- 5. The recheck #1503 asks for: active batches, inside the transaction,
  --    after the lock. A creator that waited on step 3 sees the winner's
  --    committed items here (READ COMMITTED: each statement in a VOLATILE
  --    function takes a fresh snapshot).
  IF NOT COALESCE(p_confirm_already_batched, false) THEN
    SELECT jsonb_agg(jsonb_build_object('id', i.supplier_invoice_id, 'batch_id', b.id))
      INTO v_already
      FROM public.supplier_payment_batch_items i
      JOIN public.supplier_payment_batches b
        ON b.id = i.batch_id AND b.company_id = i.company_id
     WHERE i.company_id = p_company_id
       AND b.status = 'created'
       AND i.supplier_invoice_id = ANY(v_ids);
    IF v_already IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'already_batched', 'details', v_already);
    END IF;
  END IF;

  -- 6. Header + items in this one transaction. Totals come from the items so
  --    header and rows can never disagree; the table CHECKs (amount > 0,
  --    total_amount > 0, item_count > 0, payee_fields_match) and the
  --    uniqueness / composite company FKs still fire and abort the whole call.
  SELECT round(sum((x ->> 'amount')::numeric), 2), count(*)
    INTO v_total, v_count
    FROM jsonb_array_elements(p_items) AS x;

  INSERT INTO public.supplier_payment_batches
    (id, company_id, user_id, format, status, currency, total_amount, item_count, msg_id, debtor_snapshot)
  VALUES
    (p_batch_id, p_company_id, v_actor, p_format, 'created', 'SEK', v_total, v_count, p_msg_id, p_debtor_snapshot)
  RETURNING * INTO v_batch;

  INSERT INTO public.supplier_payment_batch_items
    (batch_id, company_id, supplier_invoice_id, amount, payment_date, payee_type,
     payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_name, payee_city,
     reference_type, reference)
  SELECT p_batch_id, p_company_id, r.supplier_invoice_id, r.amount, r.payment_date, r.payee_type,
         r.payee_bankgiro, r.payee_plusgiro, r.payee_clearing, r.payee_account, r.payee_name, r.payee_city,
         r.reference_type, r.reference
    FROM jsonb_to_recordset(p_items) AS r(
      supplier_invoice_id uuid,
      amount              numeric,
      payment_date        date,
      payee_type          text,
      payee_bankgiro      text,
      payee_plusgiro      text,
      payee_clearing      text,
      payee_account       text,
      payee_name          text,
      payee_city          text,
      reference_type      text,
      reference           text
    );

  RETURN jsonb_build_object('ok', true, 'batch', to_jsonb(v_batch));
END;
$function$;

REVOKE ALL ON FUNCTION public.create_supplier_payment_batch(uuid, uuid, text, text, jsonb, jsonb, boolean, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_supplier_payment_batch(uuid, uuid, text, text, jsonb, jsonb, boolean, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
