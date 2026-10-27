-- pg-test: covered-by tests/pg/salary-correction-pays-difference.pg.test.ts
-- A correction run pays only the difference.
--
-- A rättelsekörning (lib/salary/correct-run.ts) stornos the booked run's
-- vouchers and copies its roster at FULL amounts onto a new run
-- (is_correction, corrects_run_id). That is right for the payslip and the
-- booking: the storno debits back the original's bank credit, the correction
-- credits the full corrected net, and the bank account nets to the
-- difference. create_salary_payment_orders (20261027100000) paid every
-- employee the run's full effective net, so paying a correction through the
-- bank would have paid the month a second time: a correction is only made of
-- a booked run, whose net pay has left.
--
-- This migration:
--   1. adds salary_run_payable_amounts(company, run): per employee the
--      effective net, what the chain of runs a correction replaces already
--      paid (the largest effective net, never below 0, on any run of the
--      chain: the corrected run, the run that one corrected, and so on), and
--      the payable amount, the effective net minus that. An ordinary run has
--      no chain, so its payable is its effective net, the figure paid before.
--      An employee the chain paid who is no longer on the correction has
--      payable minus what was paid (an overpayment). A correction whose
--      corrected run cannot be found in the company answers payable NULL,
--      so nothing is paid on a guess. The application computes the same
--      rule in lib/salary/payment/payable.ts (payment files, bank list,
--      previews) and the pg-real test pins that both agree;
--   2. replaces create_salary_payment_orders so each order pays the payable
--      amount and only a positive one: zero is nothing to pay, and an
--      overpayment is never paid or deducted (the preview names it, the
--      person handles it). Everything else is unchanged;
--   3. replaces salary_run_paid_by_bank so a run moves to paid when every
--      employee with a positive payable has an executed payment: a
--      correction's employees whose net did not rise have no payment to wait
--      for.

-- ---------------------------------------------------------------------------
-- 1. salary_run_payable_amounts()
-- ---------------------------------------------------------------------------
-- SECURITY INVOKER: it reads with the rights of its caller. The two callers
-- below are SECURITY DEFINER, so they read as the owner; nobody else needs
-- it, and EXECUTE is the service role's alone.
CREATE OR REPLACE FUNCTION public.salary_run_payable_amounts(
  p_company_id    uuid,
  p_salary_run_id uuid
)
RETURNS TABLE (employee_id uuid, effective_net numeric, paid_before numeric, payable numeric)
LANGUAGE sql
STABLE
SET search_path TO 'public'
AS $function$
  WITH RECURSIVE
  run AS (
    SELECT sr.corrects_run_id
      FROM public.salary_runs sr
     WHERE sr.id = p_salary_run_id
       AND sr.company_id = p_company_id
  ),
  -- The runs the correction replaces, the corrected run first. Depth-capped:
  -- a chain is a correction of a correction at most a handful of times.
  chain (run_id, next_id, depth) AS (
    SELECT prev.id, prev.corrects_run_id, 1
      FROM run
      JOIN public.salary_runs prev ON prev.id = run.corrects_run_id AND prev.company_id = p_company_id
    UNION ALL
    SELECT prev.id, prev.corrects_run_id, c.depth + 1
      FROM chain c
      JOIN public.salary_runs prev ON prev.id = c.next_id AND prev.company_id = p_company_id
     WHERE c.depth < 50
  ),
  current_run AS (
    SELECT sre.employee_id,
           round(sre.net_salary + (sre.tax_withheld - coalesce(sre.tax_withheld_override, sre.tax_withheld)), 2) AS effective_net
      FROM public.salary_run_employees sre
     WHERE sre.salary_run_id = p_salary_run_id
       AND sre.company_id = p_company_id
  ),
  paid AS (
    SELECT sre.employee_id,
           max(greatest(round(sre.net_salary + (sre.tax_withheld - coalesce(sre.tax_withheld_override, sre.tax_withheld)), 2), 0)) AS paid_before
      FROM public.salary_run_employees sre
     WHERE sre.salary_run_id IN (SELECT c.run_id FROM chain c)
       AND sre.company_id = p_company_id
     GROUP BY sre.employee_id
  )
  SELECT coalesce(cr.employee_id, p.employee_id),
         coalesce(cr.effective_net, 0),
         coalesce(p.paid_before, 0),
         CASE
           WHEN (SELECT run.corrects_run_id FROM run) IS NOT NULL AND NOT EXISTS (SELECT 1 FROM chain) THEN NULL
           ELSE coalesce(cr.effective_net, 0) - coalesce(p.paid_before, 0)
         END
    FROM current_run cr
    FULL JOIN paid p ON p.employee_id = cr.employee_id
$function$;

COMMENT ON FUNCTION public.salary_run_payable_amounts(uuid, uuid) IS
  'Per employee of a salary run: effective net, what the chain of runs a correction replaces already paid (max effective net on the chain), and the payable amount (effective net minus that; the effective net for an ordinary run). Mirrors lib/salary/payment/payable.ts.';

REVOKE ALL ON FUNCTION public.salary_run_payable_amounts(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.salary_run_payable_amounts(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 2. create_salary_payment_orders(): pays the payable amount
-- ---------------------------------------------------------------------------
-- Unchanged from 20261027100000 but for step 6, which reads the payees from
-- salary_run_payable_amounts instead of the run's effective net.
CREATE OR REPLACE FUNCTION public.create_salary_payment_orders(
  p_company_id               uuid,
  p_salary_run_id            uuid,
  p_cash_account_id          uuid,
  p_debtor_snapshot          jsonb,
  p_requested_execution_date date,
  p_reference                text,
  p_idempotency_key          text,
  p_confirmed_unpaid         boolean DEFAULT false,
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
  v_run         public.salary_runs%ROWTYPE;
  v_existing    jsonb;
  v_mismatch    uuid;
  v_payees      jsonb;
  v_replaced    uuid[];
  v_live        int;
  v_missing     jsonb;
  v_orders      jsonb;
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

  -- Never in a sandbox company: the service refuses first, and the sandbox
  -- teardown refuses on purpose to unwind a payment order.
  IF EXISTS (SELECT 1 FROM public.company_settings cs WHERE cs.company_id = p_company_id AND cs.is_sandbox) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sandbox', 'details', 'bank payments are not available in a sandbox company');
  END IF;

  -- 2. Payload. The table's CHECKs hold the rest (the debtor's account in
  --    the same company through the composite FK). The key leaves room for
  --    the colon and the employee id within the column's 200 characters.
  IF p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 160
     OR p_salary_run_id IS NULL
     OR p_cash_account_id IS NULL
     OR p_requested_execution_date IS NULL
     OR jsonb_typeof(p_debtor_snapshot) IS DISTINCT FROM 'object' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload',
                              'details', 'run, cash account, debtor, execution date and idempotency_key are required');
  END IF;
  IF p_reference IS NULL OR length(btrim(p_reference)) NOT BETWEEN 1 AND 140 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload', 'details', 'the message is 1 to 140 characters');
  END IF;

  -- 3. The run, locked: a second preparation, an unapprove and the paid
  --    step queue behind this one.
  SELECT * INTO v_run
    FROM public.salary_runs sr
   WHERE sr.id = p_salary_run_id AND sr.company_id = p_company_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'run_not_found');
  END IF;

  -- 4. Replays: an existing key returns its orders, but only salary orders
  --    of this run; a key used for anything else is a caller bug.
  SELECT po.id INTO v_mismatch
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND left(po.idempotency_key, length(p_idempotency_key) + 1) = p_idempotency_key || ':'
     AND (po.purpose IS DISTINCT FROM 'salary' OR po.salary_run_id IS DISTINCT FROM p_salary_run_id)
   LIMIT 1;
  IF v_mismatch IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'idempotency_mismatch',
                              'details', jsonb_build_object('idempotency_key', p_idempotency_key,
                                                            'payment_order_id', v_mismatch));
  END IF;
  SELECT jsonb_agg(to_jsonb(po) ORDER BY po.created_at, po.id) INTO v_existing
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND left(po.idempotency_key, length(p_idempotency_key) + 1) = p_idempotency_key || ':';
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', true, 'orders', v_existing, 'replaced_draft_ids', '[]'::jsonb);
  END IF;

  -- 5. A run that is not approved may already be paid: the book step marks
  --    it paid by itself, and a payment file may have paid it. The person
  --    confirms it was not before anything is prepared.
  IF v_run.status NOT IN ('approved', 'paid', 'booked') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'run_not_payable',
                              'details', jsonb_build_object('status', v_run.status));
  END IF;
  IF (v_run.status <> 'approved' OR v_run.payment_file_generated_at IS NOT NULL)
     AND NOT coalesce(p_confirmed_unpaid, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'confirmation_required',
                              'details', jsonb_build_object('status', v_run.status,
                                                            'payment_file_generated_at', v_run.payment_file_generated_at));
  END IF;

  -- 6. Who is paid: every employee with a positive payable amount
  --    (salary_run_payable_amounts: the effective net, or for a correction
  --    the difference against what the corrected chain already paid) and no
  --    payment approved, at the bank or executed. A payment that was
  --    rejected, failed or cancelled leaves the employee to be paid again; a
  --    draft nobody approved is replaced below. An overpaid employee (a
  --    negative payable) is never paid.
  SELECT jsonb_agg(jsonb_build_object(
           'employee_id', x.employee_id, 'amount', x.amount,
           'clearing', x.clearing, 'account', x.account, 'name', x.name) ORDER BY x.name, x.employee_id)
    INTO v_payees
    FROM (
      SELECT pa.employee_id,
             pa.payable AS amount,
             regexp_replace(coalesce(e.clearing_number, ''), '\D', '', 'g') AS clearing,
             regexp_replace(coalesce(e.bank_account_number, ''), '\D', '', 'g') AS account,
             left(btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), 140) AS name
        FROM public.salary_run_payable_amounts(p_company_id, p_salary_run_id) pa
        JOIN public.employees e ON e.id = pa.employee_id AND e.company_id = p_company_id
       WHERE pa.payable > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.payment_orders po
            WHERE po.company_id = p_company_id
              AND po.salary_run_id = p_salary_run_id
              AND po.employee_id = pa.employee_id
              AND po.purpose = 'salary'
              AND po.status IN ('approved', 'submitted', 'awaiting_signature',
                                'awaiting_second_signer', 'accepted', 'executed'))
    ) x;

  IF v_payees IS NULL THEN
    SELECT count(*) INTO v_live
      FROM public.payment_orders po
     WHERE po.company_id = p_company_id
       AND po.salary_run_id = p_salary_run_id
       AND po.purpose = 'salary'
       AND po.status IN ('approved', 'submitted', 'awaiting_signature',
                         'awaiting_second_signer', 'accepted', 'executed');
    RETURN jsonb_build_object('ok', false, 'code', 'nothing_to_pay',
                              'details', jsonb_build_object('in_payment', v_live));
  END IF;

  -- 7. Every payee needs a domestic account the order can carry. The
  --    service names a wrong one first (payeeAccountProblem); this is the
  --    last word on its shape. Checked before anything is written.
  SELECT jsonb_agg(jsonb_build_object('employee_id', p.employee_id, 'name', p.name) ORDER BY p.name) INTO v_missing
    FROM jsonb_to_recordset(v_payees) AS p(employee_id uuid, amount numeric, clearing text, account text, name text)
   WHERE p.clearing !~ '^[0-9]{4,5}$' OR p.account !~ '^[0-9]{1,17}$';
  IF v_missing IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'employee_bank_missing',
                              'details', jsonb_build_object('employees', v_missing));
  END IF;

  -- 8. The run's drafts nobody approved go first: the unique index allows
  --    one live order per employee, and the latest preparation wins.
  WITH cancelled AS (
    UPDATE public.payment_orders po
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor
     WHERE po.company_id = p_company_id
       AND po.salary_run_id = p_salary_run_id
       AND po.purpose = 'salary'
       AND po.status = 'draft'
    RETURNING po.id
  )
  SELECT array_agg(id) INTO v_replaced FROM cancelled;
  IF v_replaced IS NOT NULL THEN
    INSERT INTO public.payment_order_events
      (company_id, payment_order_id, event_type, from_status, to_status, actor_user_id, detail)
    SELECT p_company_id, id, 'cancelled', 'draft', 'cancelled', v_actor,
           jsonb_build_object('replaced_by_new_draft', true)
      FROM unnest(v_replaced) AS id;
  END IF;

  -- 9. Insert, with their events. A race the lock above did not see ends in
  --    a clean refusal, not an error.
  BEGIN
    WITH inserted AS (
      INSERT INTO public.payment_orders (
        company_id, user_id, purpose, supplier_invoice_id, salary_run_id, employee_id, status,
        amount, currency, requested_execution_date, cash_account_id, debtor_snapshot,
        payee_type, payee_clearing, payee_account, payee_name, payee_source, payee_check,
        reference_type, reference, idempotency_key)
      SELECT
        p_company_id, v_actor, 'salary', NULL, p_salary_run_id, p.employee_id, 'draft',
        p.amount, 'SEK', p_requested_execution_date, p_cash_account_id, p_debtor_snapshot,
        'bank_account', p.clearing, p.account, CASE WHEN p.name = '' THEN '-' ELSE p.name END, 'employee',
        CASE WHEN EXISTS (
          SELECT 1 FROM public.payment_orders prior
           WHERE prior.company_id = p_company_id
             AND prior.purpose = 'salary'
             AND prior.employee_id = p.employee_id
             AND prior.status = 'executed'
             AND prior.payee_clearing = p.clearing
             AND prior.payee_account = p.account) THEN 'known' ELSE 'unchecked' END,
        'message', btrim(p_reference), p_idempotency_key || ':' || p.employee_id::text
      FROM jsonb_to_recordset(v_payees) AS p(employee_id uuid, amount numeric, clearing text, account text, name text)
      RETURNING *
    ), events AS (
      INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, to_status, actor_user_id)
      SELECT p_company_id, i.id, 'created', 'draft', v_actor FROM inserted i
    )
    SELECT jsonb_agg(to_jsonb(i) ORDER BY i.payee_name, i.id) INTO v_orders FROM inserted i;
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
    IF v_constraint = 'uq_payment_orders_live_salary_per_employee' THEN
      RETURN jsonb_build_object('ok', false, 'code', 'already_in_payment', 'details', '{}'::jsonb);
    END IF;
    RAISE;
  END;

  RETURN jsonb_build_object('ok', true, 'orders', v_orders,
                            'replaced_draft_ids', to_jsonb(coalesce(v_replaced, '{}'::uuid[])));
END;
$function$;

REVOKE ALL ON FUNCTION public.create_salary_payment_orders(uuid, uuid, uuid, jsonb, date, text, text, boolean, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_salary_payment_orders(uuid, uuid, uuid, jsonb, date, text, text, boolean, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 3. salary_run_paid_by_bank(): waits only for a positive payable
-- ---------------------------------------------------------------------------
-- The trigger (AFTER UPDATE OF status ON payment_orders) stays as it is; its
-- function now asks whether every employee with a positive payable amount
-- has an executed payment, so a correction whose other employees have no
-- difference to pay still moves to paid.
CREATE OR REPLACE FUNCTION public.salary_run_paid_by_bank()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.salary_run_payable_amounts(NEW.company_id, NEW.salary_run_id) pa
     WHERE pa.payable > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.payment_orders po
          WHERE po.company_id = NEW.company_id
            AND po.salary_run_id = NEW.salary_run_id
            AND po.employee_id = pa.employee_id
            AND po.purpose = 'salary'
            AND po.status = 'executed')
  ) THEN
    UPDATE public.salary_runs
       SET status = 'paid', paid_at = now()
     WHERE id = NEW.salary_run_id
       AND company_id = NEW.company_id
       AND status = 'approved';
  END IF;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.salary_run_paid_by_bank() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
