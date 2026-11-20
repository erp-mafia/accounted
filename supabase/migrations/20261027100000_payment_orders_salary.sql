-- pg-test: covered-by tests/pg/payment-orders-salary.pg.test.ts
-- Paying a salary run through the bank: one payment per employee, the net
-- pay to the employee's own account, signed with BankID like a supplier
-- payment (one signing for the whole run when the bank takes baskets).
--
-- payment_orders.purpose held 'supplier_invoice' and 'skattekonto'
-- (20261016180000). A salary payment has no invoice and no supplier: it pays
-- one employee on one salary run, and both the amount and the account come
-- from the run and the employee card, never from the caller. This migration:
--   1. links an order to its salary run and employee (salary_run_id,
--      employee_id, both composite FKs within the company);
--   2. widens purpose with 'salary' and payee_source with 'employee';
--   3. pins what a salary order is: no supplier invoice, a run and an
--      employee, a domestic account (clearing + account, digits only), payee
--      source employee, a message reference, SEK; and the run, the employee
--      and the payee source employee belong to such an order alone;
--   4. allows one live order per employee and run (draft through executed):
--      an executed payment is never made twice;
--   5. freezes what a salary order pays (the run, the employee, the amount
--      and the payee) from the insert on, draft included: the run is the
--      only source, and an edited draft would pay something nobody computed;
--   6. moves an approved run to paid when the bank has executed a payment to
--      every employee with a positive payout (the step the person would
--      otherwise mark by hand);
--   7. refuses to take a run back to review or draft while a payment for it
--      is approved, at the bank or executed, and cancels its drafts when it
--      goes back: their amounts are about to change;
--   8. refuses to archive a payment file for a run while a payment for it is
--      live: the file and the bank payments would each pay the month;
--   9. adds create_salary_payment_orders(), the one way to create them, with
--      the guards of create_skattekonto_payment_order (actor, write role,
--      sandbox, idempotent replay) and their 'created' events.
--
-- claim_payment_orders_for_signing, rebatch_payment_orders_for_signing and
-- release_payment_order stay as they are: the invoice re-checks join
-- supplier_invoices, so an order without one passes them, and
-- release_payment_order already sends every order whose purpose is not
-- supplier_invoice back to approved (20261016180000).
--
-- Settlement of the debits stays with the salary voucher: nothing books or
-- matches the bank rows of a salary payment here. The voucher credits the
-- bank account with the net pay when the run is booked, and the rows are
-- reconciled against it the way a payment file's rows are.
--
-- Existing rows are all supplier_invoice or skattekonto orders, which every
-- new CHECK accepts: each is added NOT VALID and validated in the same
-- migration.

-- ---------------------------------------------------------------------------
-- 1. The run and the employee an order pays
-- ---------------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_runs_id_company_id_key') THEN
    ALTER TABLE public.salary_runs ADD CONSTRAINT salary_runs_id_company_id_key UNIQUE (id, company_id);
  END IF;
END $$;

ALTER TABLE public.payment_orders
  ADD COLUMN salary_run_id uuid,
  ADD COLUMN employee_id uuid;

COMMENT ON COLUMN public.payment_orders.salary_run_id IS
  'The salary run a salary payment (purpose salary) pays out; null for every other purpose. Never changes.';
COMMENT ON COLUMN public.payment_orders.employee_id IS
  'The employee a salary payment (purpose salary) pays; null for every other purpose. Never changes.';

ALTER TABLE public.payment_orders
  ADD CONSTRAINT fk_payment_orders_salary_run
    FOREIGN KEY (salary_run_id, company_id)
    REFERENCES public.salary_runs (id, company_id) ON DELETE RESTRICT,
  ADD CONSTRAINT fk_payment_orders_employee
    FOREIGN KEY (employee_id, company_id)
    REFERENCES public.employees (id, company_id) ON DELETE RESTRICT;

CREATE INDEX idx_payment_orders_salary_run_id
  ON public.payment_orders (salary_run_id)
  WHERE salary_run_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. Purpose and payee source
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_purpose_check;
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_purpose_check
  CHECK (purpose IN ('supplier_invoice', 'skattekonto', 'salary')) NOT VALID;
ALTER TABLE public.payment_orders
  VALIDATE CONSTRAINT payment_orders_purpose_check;

ALTER TABLE public.payment_orders
  DROP CONSTRAINT IF EXISTS payment_orders_payee_source_check;
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_payee_source_check
  CHECK (payee_source IN ('invoice', 'supplier', 'skatteverket', 'employee')) NOT VALID;
ALTER TABLE public.payment_orders
  VALIDATE CONSTRAINT payment_orders_payee_source_check;

-- ---------------------------------------------------------------------------
-- 3. What a salary order is
-- ---------------------------------------------------------------------------
-- The clearing and account are digits only: the provider writes them in the
-- bank's own form (a Swedbank 8xxxx clearing, a Nordea personkonto), as it
-- does for a supplier's bank account. Every column read here is NOT NULL
-- except the ones tested with IS NULL or coalesced, so the CASE is never
-- NULL: a NULL would pass a CHECK.
ALTER TABLE public.payment_orders
  ADD CONSTRAINT payment_orders_salary_instruction CHECK (
    CASE WHEN purpose = 'salary' THEN
      supplier_invoice_id IS NULL
      AND salary_run_id IS NOT NULL
      AND employee_id IS NOT NULL
      AND payee_type = 'bank_account'
      AND coalesce(payee_clearing, '') ~ '^[0-9]{4,5}$'
      AND coalesce(payee_account, '') ~ '^[0-9]{1,17}$'
      AND payee_source = 'employee'
      AND reference_type = 'message'
      AND currency = 'SEK'
    ELSE salary_run_id IS NULL AND employee_id IS NULL AND payee_source <> 'employee'
    END
  ) NOT VALID;
ALTER TABLE public.payment_orders
  VALIDATE CONSTRAINT payment_orders_salary_instruction;

-- ---------------------------------------------------------------------------
-- 4. One live order per employee and run
-- ---------------------------------------------------------------------------
-- Live: from the draft until it is executed. A rejected, failed or cancelled
-- payment frees the employee for a new one; an executed one never does.
CREATE UNIQUE INDEX uq_payment_orders_live_salary_per_employee
  ON public.payment_orders (salary_run_id, employee_id)
  WHERE purpose = 'salary'
    AND status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                   'awaiting_second_signer', 'accepted', 'executed');

-- ---------------------------------------------------------------------------
-- 5. What a salary order pays never changes
-- ---------------------------------------------------------------------------
-- The lifecycle trigger freezes the instruction once an order leaves draft.
-- A salary order is frozen from the insert on: the day may still move to a
-- banking day (approval and signing do that), nothing else it pays.
CREATE OR REPLACE FUNCTION public.freeze_salary_payment_order()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.salary_run_id IS DISTINCT FROM OLD.salary_run_id
     OR NEW.employee_id IS DISTINCT FROM OLD.employee_id THEN
    RAISE EXCEPTION 'payment_orders: the salary run and employee of an order never change'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.purpose = 'salary' AND (
       NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.payee_type IS DISTINCT FROM OLD.payee_type
       OR NEW.payee_clearing IS DISTINCT FROM OLD.payee_clearing
       OR NEW.payee_account IS DISTINCT FROM OLD.payee_account
       OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
       OR NEW.payee_source IS DISTINCT FROM OLD.payee_source
       OR NEW.reference_type IS DISTINCT FROM OLD.reference_type
       OR NEW.reference IS DISTINCT FROM OLD.reference) THEN
    RAISE EXCEPTION 'payment_orders: a salary payment pays what the run computed; prepare a new one instead of editing it'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER freeze_salary_payment_order
  BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.freeze_salary_payment_order();

-- ---------------------------------------------------------------------------
-- 6. The run is paid when the bank has paid everyone
-- ---------------------------------------------------------------------------
-- When a salary payment is executed and every employee on the run with a
-- positive payout (effectiveNetPayout: the net pay, moved by a tax override)
-- has an executed payment, an approved run moves to paid, stamped with the
-- server clock like the manual step (lib/salary/mark-paid.ts). A run that is
-- paid or booked already stays as it is. SECURITY DEFINER: the status sync
-- writes the order as the service role, a person's signing as a member, and
-- the run's step follows either.
CREATE OR REPLACE FUNCTION public.salary_run_paid_by_bank()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.salary_run_employees sre
     WHERE sre.salary_run_id = NEW.salary_run_id
       AND round(sre.net_salary + (sre.tax_withheld - coalesce(sre.tax_withheld_override, sre.tax_withheld)), 2) > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.payment_orders po
          WHERE po.company_id = NEW.company_id
            AND po.salary_run_id = NEW.salary_run_id
            AND po.employee_id = sre.employee_id
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

CREATE TRIGGER salary_run_paid_by_bank
  AFTER UPDATE OF status ON public.payment_orders
  FOR EACH ROW
  WHEN (NEW.purpose = 'salary' AND NEW.status = 'executed' AND OLD.status IS DISTINCT FROM 'executed')
  EXECUTE FUNCTION public.salary_run_paid_by_bank();

-- ---------------------------------------------------------------------------
-- 7. A run in bank payment is not taken back
-- ---------------------------------------------------------------------------
-- Taking a run back to review or draft (unapprove, revert) recomputes its
-- amounts. A payment that is approved, at the bank or executed was made from
-- the old ones, so the run stays; the person cancels the payment first (or
-- corrects the run). Drafts nobody approved are cancelled with an event: they
-- would otherwise wait under Betalningar with amounts the run no longer has.
-- SECURITY DEFINER: the person taking the run back may not write
-- payment_orders, which only the server writes.
CREATE OR REPLACE FUNCTION public.salary_run_recall_guard_bank_payments()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_live  int;
  v_ids   uuid[];
  v_actor uuid := auth.uid();
BEGIN
  IF NEW.status NOT IN ('draft', 'review') OR OLD.status IN ('draft', 'review') THEN
    RETURN NEW;
  END IF;

  SELECT count(*) INTO v_live
    FROM public.payment_orders po
   WHERE po.company_id = OLD.company_id
     AND po.salary_run_id = OLD.id
     AND po.purpose = 'salary'
     AND po.status IN ('approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted', 'executed');
  IF v_live > 0 THEN
    RAISE EXCEPTION 'salary run % has % bank payment(s) approved, at the bank or executed', OLD.id, v_live
      USING ERRCODE = 'check_violation',
            HINT = 'salary_run_in_bank_payment';
  END IF;

  WITH cancelled AS (
    UPDATE public.payment_orders po
       SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor
     WHERE po.company_id = OLD.company_id
       AND po.salary_run_id = OLD.id
       AND po.purpose = 'salary'
       AND po.status = 'draft'
    RETURNING po.id
  )
  SELECT array_agg(id) INTO v_ids FROM cancelled;
  IF v_ids IS NOT NULL THEN
    INSERT INTO public.payment_order_events
      (company_id, payment_order_id, event_type, from_status, to_status, actor_user_id, detail)
    SELECT OLD.company_id, id, 'cancelled', 'draft', 'cancelled', v_actor,
           jsonb_build_object('reason', 'salary_run_recalled')
      FROM unnest(v_ids) AS id;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.salary_run_recall_guard_bank_payments() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER salary_run_recall_guard_bank_payments
  BEFORE UPDATE OF status ON public.salary_runs
  FOR EACH ROW EXECUTE FUNCTION public.salary_run_recall_guard_bank_payments();

-- ---------------------------------------------------------------------------
-- 8. No payment file beside live bank payments
-- ---------------------------------------------------------------------------
-- Every payment file is archived before it is handed out
-- (lib/salary/payment/build-payment-file.ts), so refusing the archive refuses
-- the file. The builder says it first, by name; this is the last word.
CREATE OR REPLACE FUNCTION public.refuse_salary_payment_file_in_bank_payment()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.payment_orders po
     WHERE po.company_id = NEW.company_id
       AND po.salary_run_id = NEW.salary_run_id
       AND po.purpose = 'salary'
       AND po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                         'awaiting_second_signer', 'accepted', 'executed')) THEN
    RAISE EXCEPTION 'salary run % is paid through the bank: a payment file would pay it a second time', NEW.salary_run_id
      USING ERRCODE = 'check_violation',
            HINT = 'salary_run_in_bank_payment';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.refuse_salary_payment_file_in_bank_payment() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER refuse_salary_payment_file_in_bank_payment
  BEFORE INSERT ON public.salary_payment_files
  FOR EACH ROW EXECUTE FUNCTION public.refuse_salary_payment_file_in_bank_payment();

-- ---------------------------------------------------------------------------
-- 9. create_salary_payment_orders()
-- ---------------------------------------------------------------------------
-- The one way to create salary payments. The caller names the run, the
-- account the money leaves from (cash account + debtor snapshot, read by the
-- service as for every payment), the day, the message the employees see and
-- an idempotency key; each order's key is that key, a colon and the
-- employee id. Everything the payment pays is read here: every employee on
-- the run with a positive payout and no live payment gets one draft order of
-- that payout to the clearing and account on the employee card. payee_check
-- is 'known' when an executed salary payment already went to that employee's
-- account, 'unchecked' otherwise: an employee account is the employer's own
-- record, with no invoice to compare it with.
--
-- The run must be approved, or paid or booked with p_confirmed_unpaid: the
-- person confirms the net pay has not left by another way (the book step
-- marks a run paid by itself). The same confirmation is needed once a payment
-- file was made for the run. Drafts of the run nobody approved are cancelled
-- first, so the latest preparation wins.
--
-- Returns {ok: true, orders, replaced_draft_ids} or {ok: false, code,
-- details} with code one of: sandbox, invalid_payload, idempotency_mismatch,
-- run_not_found, run_not_payable, confirmation_required, nothing_to_pay,
-- employee_bank_missing, already_in_payment.
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

  -- 6. Who is paid: every employee with a positive payout and no payment
  --    approved, at the bank or executed. A payment that was rejected,
  --    failed or cancelled leaves the employee to be paid again; a draft
  --    nobody approved is replaced below.
  SELECT jsonb_agg(jsonb_build_object(
           'employee_id', x.employee_id, 'amount', x.amount,
           'clearing', x.clearing, 'account', x.account, 'name', x.name) ORDER BY x.name, x.employee_id)
    INTO v_payees
    FROM (
      SELECT sre.employee_id,
             round(sre.net_salary + (sre.tax_withheld - coalesce(sre.tax_withheld_override, sre.tax_withheld)), 2) AS amount,
             regexp_replace(coalesce(e.clearing_number, ''), '\D', '', 'g') AS clearing,
             regexp_replace(coalesce(e.bank_account_number, ''), '\D', '', 'g') AS account,
             left(btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')), 140) AS name
        FROM public.salary_run_employees sre
        JOIN public.employees e ON e.id = sre.employee_id AND e.company_id = p_company_id
       WHERE sre.salary_run_id = p_salary_run_id
         AND round(sre.net_salary + (sre.tax_withheld - coalesce(sre.tax_withheld_override, sre.tax_withheld)), 2) > 0
         AND NOT EXISTS (
           SELECT 1 FROM public.payment_orders po
            WHERE po.company_id = p_company_id
              AND po.salary_run_id = p_salary_run_id
              AND po.employee_id = sre.employee_id
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

NOTIFY pgrst, 'reload schema';
