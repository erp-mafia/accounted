-- Payment and credit-note forwarding to the collections provider: the outbox
-- of what the ledger must report about an invoice under collection, and the
-- record of what it did report.
-- pg-test: tests/pg/collection-payment-forwards.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/sandbox-cleanup.pg.test.ts,
--          tests/pg/definer-function-grants.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts,
--          tests/pg/full-archive-coverage.pg.test.ts
--
-- While the provider holds a case, every payment the customer makes directly
-- to the company, and every credit note issued against the invoice, must
-- reach the provider before it sends the next letter: otherwise it keeps
-- dunning a customer who already paid. Triggers fill the outbox from every
-- write path (the app's single payment writer, the SQL RPCs that insert
-- payment rows directly, the storno and unmatch paths that delete them, the
-- credit-note issue paths); the drain (lib/collections/forwarding.ts, from
-- the sync cron and right after a payment route answers) sends each row once
-- through Connect, with the forward row's id as the idempotency key and the
-- invoice_payments row id as the payment's reference at the provider, so the
-- same id later reverts it.
--
-- A row's life:
--   pending         reported next (kind payment or credit_note)
--   forwarded       the provider holds it (sent_amount; ignored_amount is the
--                   part above the provider's remaining principal)
--   revert_pending  the payment row was removed after it was reported: the
--                   provider must drop it again
--   reverted        the provider dropped it
--   skipped         nothing to send: removed before it was reported, the
--                   handover failed, the case closed without payment, or the
--                   whole amount was above the remaining principal
--   failed          gave up after repeated failures; a person retries it
--                   (forwarded_at says whether the report or the revert
--                   failed)
--
-- Payments the provider collected itself (invoice_payments.source =
-- 'collections') are never forwarded: it already holds them.

-- =============================================================================
-- 1. collection_payment_forwards
-- =============================================================================

CREATE TABLE public.collection_payment_forwards (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES public.collection_cases(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('payment', 'credit_note')),
  -- No foreign key: the payment row may be removed later, and its forward
  -- must still be reverted.
  invoice_payment_id uuid,
  -- No foreign key either: a credit note whose issue failed goes back to
  -- draft and may then be deleted; its skipped forward keeps the id.
  credit_invoice_id uuid,
  -- In the invoice currency (cases are SEK only), as recorded in the books.
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  payment_date date NOT NULL,

  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'forwarded', 'revert_pending', 'reverted', 'skipped', 'failed')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz,
  lease_until timestamptz,
  lease_token uuid,
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),

  -- The amount in the request sent under this row's key, fixed at the first
  -- attempt (the cap at the provider's remaining principal), so a retry
  -- repeats the same body and Connect answers it with the first result.
  request_amount numeric(14,2) CHECK (request_amount IS NULL OR request_amount > 0),
  -- What the provider holds: the amount reported (after the cap at its
  -- remaining principal) and the part of `amount` it does not hold.
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) <= 128),
  sent_amount numeric(14,2) CHECK (sent_amount IS NULL OR sent_amount >= 0),
  ignored_amount numeric(14,2) CHECK (ignored_amount IS NULL OR ignored_amount >= 0),
  forwarded_at timestamptz,
  -- Seen in the case snapshot's reported payments.
  acknowledged_at timestamptz,
  reverted_at timestamptz,

  -- A person looked at a failed forward or at an amount the provider does
  -- not hold (Att göra "kring inkasso behöver åtgärdas").
  attention_resolved_at timestamptz,
  attention_resolved_by uuid REFERENCES auth.users(id),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_payment_forwards_subject CHECK (
    (kind = 'payment' AND invoice_payment_id IS NOT NULL AND credit_invoice_id IS NULL)
    OR (kind = 'credit_note' AND credit_invoice_id IS NOT NULL AND invoice_payment_id IS NULL)
  ),
  -- A credit note cannot be removed once issued, so it is never reverted.
  CONSTRAINT collection_payment_forwards_credit_not_reverted CHECK (
    kind = 'payment' OR status NOT IN ('revert_pending', 'reverted')
  ),
  CONSTRAINT collection_payment_forwards_lease_shape CHECK ((lease_until IS NULL) = (lease_token IS NULL)),
  CONSTRAINT collection_payment_forwards_forwarded_shape CHECK (
    status NOT IN ('forwarded', 'revert_pending', 'reverted') OR forwarded_at IS NOT NULL
  )
);

COMMENT ON TABLE public.collection_payment_forwards IS
  'Outbox and record of the payments and credit notes reported to the collections provider for an invoice under collection.';
COMMENT ON COLUMN public.collection_payment_forwards.invoice_payment_id IS
  'The invoice_payments row reported; also its reference at the provider. No foreign key: a removed payment is still reverted.';

CREATE UNIQUE INDEX collection_payment_forwards_payment
  ON public.collection_payment_forwards (case_id, invoice_payment_id)
  WHERE kind = 'payment';
CREATE UNIQUE INDEX collection_payment_forwards_credit
  ON public.collection_payment_forwards (case_id, credit_invoice_id)
  WHERE kind = 'credit_note';
CREATE INDEX collection_payment_forwards_due
  ON public.collection_payment_forwards (case_id, created_at)
  WHERE status IN ('pending', 'revert_pending');
CREATE INDEX collection_payment_forwards_company ON public.collection_payment_forwards (company_id, status);
CREATE INDEX collection_payment_forwards_by_payment
  ON public.collection_payment_forwards (invoice_payment_id)
  WHERE invoice_payment_id IS NOT NULL;
CREATE INDEX collection_payment_forwards_credit_invoice
  ON public.collection_payment_forwards (credit_invoice_id)
  WHERE credit_invoice_id IS NOT NULL;

ALTER TABLE public.collection_payment_forwards ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_payment_forwards_select" ON public.collection_payment_forwards
  FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_payment_forwards TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_payment_forwards TO service_role;
-- no-grant: anon on public.collection_payment_forwards (company data)

CREATE TRIGGER collection_payment_forwards_updated_at
  BEFORE UPDATE ON public.collection_payment_forwards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A forward belongs to its case's company, and a credit note to the case's invoice.
CREATE OR REPLACE FUNCTION public.collection_payment_forward_shape_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.company_id = OLD.company_id
     AND NEW.case_id = OLD.case_id
     AND NEW.kind = OLD.kind
     AND NEW.invoice_payment_id IS NOT DISTINCT FROM OLD.invoice_payment_id
     AND NEW.credit_invoice_id IS NOT DISTINCT FROM OLD.credit_invoice_id THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'A collection payment forward keeps its company, case and subject'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_cases c WHERE c.id = NEW.case_id AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'A collection payment forward belongs to its case''s company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.kind = 'credit_note' AND NOT EXISTS (
    SELECT 1 FROM public.invoices cn
      JOIN public.collection_cases c ON c.id = NEW.case_id
     WHERE cn.id = NEW.credit_invoice_id
       AND cn.company_id = NEW.company_id
       AND cn.credited_invoice_id = c.invoice_id
  ) THEN
    RAISE EXCEPTION 'A forwarded credit note credits the case''s invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_payment_forward_shape_guard
  BEFORE INSERT OR UPDATE ON public.collection_payment_forwards
  FOR EACH ROW EXECUTE FUNCTION public.collection_payment_forward_shape_guard();

-- =============================================================================
-- 2. Which case a new payment or credit note is reported to
-- =============================================================================
-- A case the provider holds or is being handed (submitted: the call is in
-- flight; its rows wait until it is registered). A case the provider closed
-- as paid stays reachable for 90 days: when a person unmatches a reported
-- payment and matches it again, the revert reopens the claim at the provider,
-- and the new payment row must follow it there or the customer is dunned for
-- an invoice that is paid. Credit notes go to open cases only.

CREATE OR REPLACE FUNCTION public.collection_forward_case_for_invoice(
  p_company_id uuid,
  p_invoice_id uuid,
  p_include_closed_paid boolean
)
RETURNS uuid
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT c.id
    FROM public.collection_cases c
   WHERE c.company_id = p_company_id
     AND c.invoice_id = p_invoice_id
     AND c.submission_status IN ('submitted', 'registered')
     AND (
       c.is_open
       OR (p_include_closed_paid
           AND c.close_reason = 'paid'
           AND c.closed_at > now() - interval '90 days')
     )
   ORDER BY c.is_open DESC, c.created_at DESC
   LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.collection_forward_case_for_invoice(uuid, uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.collection_forward_case_for_invoice(uuid, uuid, boolean) TO service_role;

-- =============================================================================
-- 3. Triggers: payments
-- =============================================================================

-- Every payment row written on an invoice under collection, whatever wrote
-- it (recordInvoicePaymentRow, match_batch_allocate, the link-voucher RPCs,
-- coordinate_cash_history), except the provider's own collections.
CREATE OR REPLACE FUNCTION public.collection_forward_payment_inserted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case uuid;
BEGIN
  IF NEW.source IS NOT DISTINCT FROM 'collections' OR NEW.amount IS NULL OR round(NEW.amount, 2) <= 0 THEN
    RETURN NULL;
  END IF;
  v_case := public.collection_forward_case_for_invoice(NEW.company_id, NEW.invoice_id, true);
  IF v_case IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.collection_payment_forwards
    (company_id, case_id, kind, invoice_payment_id, amount, payment_date, status)
  VALUES (NEW.company_id, v_case, 'payment', NEW.id, round(NEW.amount, 2), NEW.payment_date, 'pending')
  ON CONFLICT (case_id, invoice_payment_id) WHERE kind = 'payment' DO NOTHING;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.collection_forward_payment_inserted() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER collection_forward_payment_inserted
  AFTER INSERT ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.collection_forward_payment_inserted();

-- A removed payment row (storno, unmatch, a failed settlement's rollback,
-- any RPC): reported -> the provider must drop it; not yet reported ->
-- nothing to send. A revert that already failed stays failed for a person.
CREATE OR REPLACE FUNCTION public.collection_forward_payment_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.collection_payment_forwards f
     SET status = CASE WHEN f.status = 'forwarded' THEN 'revert_pending' ELSE 'skipped' END,
         attempts = CASE WHEN f.status = 'forwarded' THEN 0 ELSE f.attempts END,
         next_attempt_at = NULL,
         last_error = CASE WHEN f.status = 'forwarded' THEN NULL ELSE 'payment_removed' END
   WHERE f.kind = 'payment'
     AND f.invoice_payment_id = OLD.id
     AND (f.status IN ('pending', 'forwarded') OR (f.status = 'failed' AND f.forwarded_at IS NULL));
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.collection_forward_payment_deleted() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER collection_forward_payment_deleted
  AFTER DELETE ON public.invoice_payments
  FOR EACH ROW EXECUTE FUNCTION public.collection_forward_payment_deleted();

-- =============================================================================
-- 4. Trigger: credit notes
-- =============================================================================
-- A credit note is issued when it leaves draft: the send and mark-sent
-- routes flip draft -> sent (issueCreditNote, lib/invoices/issue-credit-note.ts),
-- the v1 credit route inserts it as sent. A cancelled draft that is reopened
-- and issued later counts at that later issue. The amount is the customer's
-- share (a ROT/RUT deduction is never the customer's to pay).

CREATE OR REPLACE FUNCTION public.collection_forward_credit_note()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case uuid;
  v_amount numeric;
BEGIN
  -- An issue that failed before its voucher was made puts the credit note
  -- back to draft (the send and mark-sent routes): what was not reported yet
  -- is not reported.
  IF COALESCE(NEW.status, 'draft') IN ('draft', 'cancelled') THEN
    IF TG_OP = 'UPDATE' AND COALESCE(OLD.status, 'draft') NOT IN ('draft', 'cancelled') THEN
      UPDATE public.collection_payment_forwards f
         SET status = 'skipped',
             next_attempt_at = NULL,
             last_error = 'credit_note_withdrawn'
       WHERE f.kind = 'credit_note'
         AND f.credit_invoice_id = NEW.id
         AND f.forwarded_at IS NULL
         AND f.status IN ('pending', 'failed');
    END IF;
    RETURN NULL;
  END IF;
  IF TG_OP = 'UPDATE' AND COALESCE(OLD.status, 'draft') NOT IN ('draft', 'cancelled') THEN
    RETURN NULL;
  END IF;
  v_amount := round(abs(COALESCE(NEW.total, 0)) - abs(COALESCE(NEW.deduction_total, 0)), 2);
  IF v_amount <= 0 THEN
    RETURN NULL;
  END IF;
  v_case := public.collection_forward_case_for_invoice(NEW.company_id, NEW.credited_invoice_id, false);
  IF v_case IS NULL THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.collection_payment_forwards
    (company_id, case_id, kind, credit_invoice_id, amount, payment_date, status)
  VALUES (NEW.company_id, v_case, 'credit_note', NEW.id, v_amount,
          COALESCE(NEW.invoice_date, (now() AT TIME ZONE 'Europe/Stockholm')::date), 'pending')
  -- Issued again after it went back to draft: report it now.
  ON CONFLICT (case_id, credit_invoice_id) WHERE kind = 'credit_note' DO UPDATE
    SET status = 'pending',
        amount = EXCLUDED.amount,
        payment_date = EXCLUDED.payment_date,
        attempts = 0,
        next_attempt_at = NULL,
        request_amount = NULL,
        last_error = NULL
    WHERE collection_payment_forwards.status = 'skipped'
      AND collection_payment_forwards.forwarded_at IS NULL;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.collection_forward_credit_note() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER collection_forward_credit_note
  AFTER INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.credited_invoice_id IS NOT NULL)
  EXECUTE FUNCTION public.collection_forward_credit_note();

-- A credit note removed again (the credit routes delete the header when its
-- lines cannot be written): what was not reported yet is not reported.
CREATE OR REPLACE FUNCTION public.collection_forward_credit_note_deleted()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.collection_payment_forwards f
     SET status = 'skipped',
         next_attempt_at = NULL,
         last_error = 'credit_note_removed'
   WHERE f.kind = 'credit_note'
     AND f.credit_invoice_id = OLD.id
     AND f.forwarded_at IS NULL
     AND f.status IN ('pending', 'failed');
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.collection_forward_credit_note_deleted() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER collection_forward_credit_note_deleted
  AFTER DELETE ON public.invoices
  FOR EACH ROW
  WHEN (OLD.credited_invoice_id IS NOT NULL)
  EXECUTE FUNCTION public.collection_forward_credit_note_deleted();

-- =============================================================================
-- 5. Trigger: a handover the provider refused
-- =============================================================================
-- The case never reached the provider: what waited for it has nowhere to go.

CREATE OR REPLACE FUNCTION public.collection_forward_case_failed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.collection_payment_forwards f
     SET status = 'skipped',
         next_attempt_at = NULL,
         lease_until = NULL,
         lease_token = NULL,
         last_error = 'case_submission_failed'
   WHERE f.case_id = NEW.id
     AND f.status = 'pending';
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.collection_forward_case_failed() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER collection_forward_case_failed
  AFTER UPDATE OF submission_status ON public.collection_cases
  FOR EACH ROW
  WHEN (NEW.submission_status = 'failed' AND OLD.submission_status IS DISTINCT FROM 'failed')
  EXECUTE FUNCTION public.collection_forward_case_failed();

-- =============================================================================
-- 6. Seeding at registration
-- =============================================================================
-- The handover request already told the provider about the payments and
-- credit notes recorded before it (priorPayments, priorCredits). They are
-- written here as forwarded, so removing one later reverts it at the
-- provider and no later run reports it a second time. A payment removed
-- between the request and this call goes straight to revert_pending. Refs
-- that are not a payment row of the case's invoice (the paid_amount gap of
-- an invoice paid in part in another system) are not rows and are skipped.
-- Called by the case service (lib/collections/open-case.ts) before it stores
-- the registration, so the drain never sees the case registered without them.

CREATE OR REPLACE FUNCTION public.seed_collection_forwards(
  p_case_id uuid,
  p_payments jsonb,
  p_credits jsonb
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_case public.collection_cases%ROWTYPE;
  v_item jsonb;
  v_ref text;
  v_count integer := 0;
  v_uuid constant text := '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';
BEGIN
  SELECT * INTO v_case FROM public.collection_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'COLLECTION_CASE_NOT_FOUND' USING ERRCODE = 'no_data_found';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_payments, '[]'::jsonb)) LOOP
    v_ref := v_item->>'paymentRef';
    CONTINUE WHEN v_ref IS NULL OR v_ref !~ v_uuid OR round((v_item->>'amount')::numeric, 2) <= 0;
    -- A payment row of another invoice is never this case's to report or revert.
    CONTINUE WHEN EXISTS (
      SELECT 1 FROM public.invoice_payments ip
       WHERE ip.id = v_ref::uuid AND (ip.invoice_id <> v_case.invoice_id OR ip.company_id <> v_case.company_id)
    );
    INSERT INTO public.collection_payment_forwards
      (company_id, case_id, kind, invoice_payment_id, amount, payment_date, status,
       sent_amount, ignored_amount, forwarded_at)
    VALUES (
      v_case.company_id, v_case.id, 'payment', v_ref::uuid,
      round((v_item->>'amount')::numeric, 2), (v_item->>'date')::date,
      CASE WHEN EXISTS (SELECT 1 FROM public.invoice_payments ip WHERE ip.id = v_ref::uuid)
           THEN 'forwarded' ELSE 'revert_pending' END,
      round((v_item->>'amount')::numeric, 2), 0, now()
    )
    ON CONFLICT (case_id, invoice_payment_id) WHERE kind = 'payment' DO UPDATE
      SET status = 'forwarded',
          sent_amount = EXCLUDED.sent_amount,
          ignored_amount = 0,
          forwarded_at = EXCLUDED.forwarded_at,
          next_attempt_at = NULL,
          lease_until = NULL,
          lease_token = NULL
      WHERE collection_payment_forwards.status = 'pending';
    v_count := v_count + 1;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(p_credits, '[]'::jsonb)) LOOP
    v_ref := v_item->>'creditRef';
    CONTINUE WHEN v_ref IS NULL OR v_ref !~ v_uuid OR round((v_item->>'amount')::numeric, 2) <= 0;
    CONTINUE WHEN NOT EXISTS (
      SELECT 1 FROM public.invoices cn
       WHERE cn.id = v_ref::uuid AND cn.company_id = v_case.company_id AND cn.credited_invoice_id = v_case.invoice_id
    );
    INSERT INTO public.collection_payment_forwards
      (company_id, case_id, kind, credit_invoice_id, amount, payment_date, status,
       sent_amount, ignored_amount, forwarded_at)
    VALUES (
      v_case.company_id, v_case.id, 'credit_note', v_ref::uuid,
      round((v_item->>'amount')::numeric, 2), (v_item->>'date')::date, 'forwarded',
      round((v_item->>'amount')::numeric, 2), 0, now()
    )
    ON CONFLICT (case_id, credit_invoice_id) WHERE kind = 'credit_note' DO UPDATE
      SET status = 'forwarded',
          sent_amount = EXCLUDED.sent_amount,
          ignored_amount = 0,
          forwarded_at = EXCLUDED.forwarded_at,
          next_attempt_at = NULL,
          lease_until = NULL,
          lease_token = NULL
      WHERE collection_payment_forwards.status = 'pending';
    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.seed_collection_forwards(uuid, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.seed_collection_forwards(uuid, jsonb, jsonb) TO service_role;

-- =============================================================================
-- 7. The drain: claim and finish
-- =============================================================================
-- claim_collection_forwards hands out at most one row per case per call: the
-- case's head, a revert before anything else (so the provider's remaining
-- principal is right before the next report), then in creation order. A case
-- whose head is leased, resting after a failure, or not yet registered at the
-- provider waits whole, so a case's rows reach the provider in order. Rows
-- are locked with SKIP LOCKED and leased with a token: two drains (the cron
-- and a payment route's after-hook) never send one row twice, and a drain
-- that died leaves a lease that simply runs out. Each claim counts as an
-- attempt.

CREATE OR REPLACE FUNCTION public.claim_collection_forwards(
  p_limit integer,
  p_lease_seconds integer,
  p_company_id uuid DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  company_id uuid,
  case_id uuid,
  kind text,
  invoice_payment_id uuid,
  credit_invoice_id uuid,
  amount numeric,
  payment_date date,
  status text,
  attempts integer,
  request_amount numeric,
  sent_amount numeric,
  lease_token uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
BEGIN
  IF p_limit IS NULL OR p_limit < 1 OR p_limit > 500 THEN
    RAISE EXCEPTION 'p_limit must be between 1 and 500' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  IF p_lease_seconds IS NULL OR p_lease_seconds < 10 OR p_lease_seconds > 3600 THEN
    RAISE EXCEPTION 'p_lease_seconds must be between 10 and 3600' USING ERRCODE = 'invalid_parameter_value';
  END IF;

  RETURN QUERY
  WITH heads AS (
    SELECT DISTINCT ON (f.case_id) f.id AS head_id
      FROM public.collection_payment_forwards f
     WHERE f.status IN ('pending', 'revert_pending')
       AND (p_company_id IS NULL OR f.company_id = p_company_id)
     ORDER BY f.case_id, (f.status = 'revert_pending') DESC, f.created_at, f.id
  ),
  due AS (
    SELECT f.id AS due_id
      FROM public.collection_payment_forwards f
      JOIN heads h ON h.head_id = f.id
      JOIN public.collection_cases c ON c.id = f.case_id
     WHERE f.status IN ('pending', 'revert_pending')
       AND (f.next_attempt_at IS NULL OR f.next_attempt_at <= now())
       AND (f.lease_until IS NULL OR f.lease_until < now())
       AND c.submission_status = 'registered'
       AND c.provider_case_ref IS NOT NULL
     ORDER BY f.created_at, f.id
     LIMIT p_limit
     FOR UPDATE OF f SKIP LOCKED
  )
  UPDATE public.collection_payment_forwards f
     SET lease_until = now() + make_interval(secs => p_lease_seconds),
         lease_token = gen_random_uuid(),
         attempts = f.attempts + 1
    FROM due
   WHERE f.id = due.due_id
  RETURNING f.id, f.company_id, f.case_id, f.kind, f.invoice_payment_id, f.credit_invoice_id,
            f.amount, f.payment_date, f.status, f.attempts, f.request_amount, f.sent_amount, f.lease_token;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_collection_forwards(integer, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_collection_forwards(integer, integer, uuid) TO service_role;

-- Finish a claimed row, only with the token of the lease that claimed it.
--   reported  the provider holds the report: forwarded. If the payment row
--             was removed while the report was in flight (the delete trigger
--             found the row pending and skipped it), the provider now holds
--             a payment the books do not: revert_pending.
--   reverted  the provider dropped it.
--   retry     try again at p_retry_at.
--   failed    give up; a person retries it from the case card.
--   skipped   nothing to send (p_error says why).
-- Answers the row's new status, or 'lease_lost' when the lease ran out and
-- another drain may hold the row (nothing is changed then).

CREATE OR REPLACE FUNCTION public.finish_collection_forward(
  p_forward_id uuid,
  p_lease_token uuid,
  p_result text,
  p_provider_ref text DEFAULT NULL,
  p_sent_amount numeric DEFAULT NULL,
  p_ignored_amount numeric DEFAULT NULL,
  p_error text DEFAULT NULL,
  p_retry_at timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_row public.collection_payment_forwards%ROWTYPE;
  v_status text;
BEGIN
  IF p_result NOT IN ('reported', 'reverted', 'retry', 'failed', 'skipped') THEN
    RAISE EXCEPTION 'unknown result %', p_result USING ERRCODE = 'invalid_parameter_value';
  END IF;
  SELECT * INTO v_row FROM public.collection_payment_forwards WHERE id = p_forward_id FOR UPDATE;
  IF NOT FOUND OR v_row.lease_token IS DISTINCT FROM p_lease_token THEN
    RETURN 'lease_lost';
  END IF;

  v_status := CASE p_result
    WHEN 'reported' THEN CASE WHEN v_row.status = 'skipped' AND v_row.kind = 'payment' THEN 'revert_pending' ELSE 'forwarded' END
    WHEN 'reverted' THEN 'reverted'
    WHEN 'retry' THEN v_row.status
    WHEN 'failed' THEN 'failed'
    ELSE 'skipped'
  END;
  -- A report finished for a row that is no longer pending (removed in flight
  -- is the one case handled above) and a revert for a row that is no longer
  -- revert_pending change nothing but the lease.
  -- A row skipped while its report was in flight (the payment was removed)
  -- that did not get through stays skipped; the provider's own list of
  -- reported payments is compared with the books by the reconcile.
  IF p_result = 'reported' AND v_row.status NOT IN ('pending', 'skipped') THEN
    v_status := v_row.status;
  ELSIF p_result = 'reverted' AND v_row.status <> 'revert_pending' THEN
    v_status := v_row.status;
  ELSIF p_result IN ('retry', 'failed') AND v_row.status = 'skipped' THEN
    v_status := 'skipped';
  END IF;

  UPDATE public.collection_payment_forwards f
     SET status = v_status,
         lease_until = NULL,
         lease_token = NULL,
         next_attempt_at = CASE WHEN p_result = 'retry' THEN p_retry_at ELSE NULL END,
         last_error = CASE
           WHEN p_result IN ('retry', 'failed', 'skipped') THEN left(p_error, 500)
           WHEN v_status = 'revert_pending' THEN 'payment_removed_in_flight'
           ELSE NULL
         END,
         provider_ref = CASE WHEN p_result = 'reported' THEN left(p_provider_ref, 128) ELSE f.provider_ref END,
         sent_amount = CASE WHEN p_result = 'reported' THEN round(p_sent_amount, 2) ELSE f.sent_amount END,
         ignored_amount = CASE
           WHEN p_result IN ('reported', 'skipped') AND p_ignored_amount IS NOT NULL THEN round(p_ignored_amount, 2)
           ELSE f.ignored_amount
         END,
         forwarded_at = CASE WHEN p_result = 'reported' THEN now() ELSE f.forwarded_at END,
         reverted_at = CASE WHEN p_result = 'reverted' AND v_status = 'reverted' THEN now() ELSE f.reverted_at END,
         attempts = CASE WHEN v_status = 'revert_pending' AND p_result = 'reported' THEN 0 ELSE f.attempts END
   WHERE f.id = p_forward_id;
  RETURN v_status;
END;
$$;

REVOKE ALL ON FUNCTION public.finish_collection_forward(uuid, uuid, text, text, numeric, numeric, text, timestamptz)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finish_collection_forward(uuid, uuid, text, text, numeric, numeric, text, timestamptz)
  TO service_role;

-- =============================================================================
-- 8. Att göra: forwards a person must look at
-- =============================================================================
-- Rebuilt from 20261012030200_collection_cases.sql (the latest definition),
-- adding two reasons, one row per forward:
--   forward_failed  a report or revert the drain gave up on.
--                   Done: a person retries it (it is pending again) or marks
--                   it handled; a report whose payment was removed is
--                   skipped.
--   payment_excess  part of a payment or credit note above the provider's
--                   remaining principal: the customer may have paid twice.
--                   Done: a person marks it handled.

CREATE OR REPLACE FUNCTION public.collection_attention_case_ids(p_company_id uuid)
RETURNS TABLE (case_id uuid, invoice_id uuid, reason text)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.id, c.invoice_id,
         CASE WHEN c.submission_status = 'failed' THEN 'submission_failed' ELSE 'sync_error' END
    FROM public.collection_cases c
    JOIN public.invoices i ON i.id = c.invoice_id
   WHERE c.company_id = p_company_id
     AND (
       (c.submission_status = 'failed'
         AND i.status IN ('sent', 'overdue', 'partially_paid')
         AND NOT EXISTS (
           SELECT 1 FROM public.collection_cases n
            WHERE n.invoice_id = c.invoice_id AND n.created_at > c.created_at
         ))
       OR (c.is_open AND c.sync_error IS NOT NULL)
     )
  UNION ALL
  SELECT c.id, c.invoice_id,
         CASE WHEN f.status = 'failed' THEN 'forward_failed' ELSE 'payment_excess' END
    FROM public.collection_payment_forwards f
    JOIN public.collection_cases c ON c.id = f.case_id
   WHERE f.company_id = p_company_id
     AND f.attention_resolved_at IS NULL
     AND (f.status = 'failed' OR (f.status IN ('forwarded', 'skipped') AND f.ignored_amount > 0))
$$;

REVOKE ALL ON FUNCTION public.collection_attention_case_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_attention_case_ids(uuid) TO authenticated, service_role;

-- =============================================================================
-- 9. cleanup_sandbox_user: the forwards and the payment rows
-- =============================================================================
-- Rebuilt from 20261012030200_collection_cases.sql (the latest definition).
-- The only changes: the forwards go before the case trail and the cases
-- (they hold a RESTRICT reference to their case), and the
-- invoice payment rows go explicitly before the invoices, while
-- company_settings still exists (block_delete_collected_payment re-verifies
-- the sandbox through it).

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
  v_companies uuid[];
  v_company uuid;
BEGIN
  -- Verify this is a sandbox user: at least one settings row, and EVERY
  -- settings row flagged sandbox.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  SELECT array_agg(cs.company_id ORDER BY cs.company_id) INTO v_companies
    FROM public.company_settings cs WHERE cs.user_id = p_user_id AND cs.is_sandbox IS TRUE;

  -- The account delete at the end cascades into every company the user
  -- created and every row they authored through a user_id foreign key, with
  -- the delete bypass set. Refuse while anything of theirs lives outside the
  -- sandbox set: a membership, a created company, or authored vouchers or
  -- documents (the BFL-retained rows a former membership can leave behind).
  IF EXISTS (SELECT 1 FROM public.company_members cm
             WHERE cm.user_id = p_user_id AND cm.company_id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.companies c
                WHERE c.created_by = p_user_id AND c.id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.journal_entries je
                WHERE je.user_id = p_user_id AND je.company_id <> ALL (v_companies))
     OR EXISTS (SELECT 1 FROM public.document_attachments d
                WHERE d.user_id = p_user_id AND d.company_id <> ALL (v_companies)) THEN
    RAISE EXCEPTION 'User % has data in a company that is not a sandbox', p_user_id;
  END IF;

  -- Serialize teardown with every worker before changing holds or receipts.
  FOREACH v_company IN ARRAY v_companies LOOP
    PERFORM pg_advisory_xact_lock(hashtextextended('sie-company:' || v_company::text, 0));
    -- Pin the classification until teardown finishes. company_id is unique,
    -- but fail closed even if future schema changes permit conflicting rows.
    PERFORM 1 FROM public.company_settings cs WHERE cs.company_id = v_company FOR SHARE;
    IF NOT FOUND OR EXISTS (SELECT 1 FROM public.company_settings cs
      WHERE cs.company_id = v_company AND cs.is_sandbox IS NOT TRUE) THEN
      RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
    END IF;
  END LOOP;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- SIE work state: remove the SIE-only blockers while the classification
  -- remains available to each retention guard, then release holds and the
  -- IB review pointers so the ordinary deletes below can run.
  DELETE FROM public.sie_duplicate_repair_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_import_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_period_read_leases WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET opening_balance_review_import_id = NULL,
    opening_balance_review_token = NULL, opening_balance_review_entry_id = NULL,
    opening_balance_review_reason = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.sie_imports SET opening_balance_entry_id = NULL WHERE company_id = ANY(v_companies);

  -- The user's API keys die with the account; api_keys.sod_acknowledged_by
  -- (NO ACTION to auth.users) would otherwise block the account delete.
  DELETE FROM public.api_keys WHERE user_id = p_user_id OR company_id = ANY(v_companies);

  -- WORM logs and registers whose delete guard re-verifies sandbox-ness
  -- through company_settings: purged first, while it still exists.
  DELETE FROM public.dimension_retag_log WHERE company_id = ANY(v_companies);
  -- Match log: some rows carry no company_id (lib/invoices/match-log.ts), so
  -- the user's own rows go too; purged before supplier_invoices because
  -- payment_match_log_supplier_invoice_id_fkey is ON DELETE SET NULL and the
  -- guard refuses that UPDATE even during teardown.
  DELETE FROM public.payment_match_log
  WHERE user_id = p_user_id OR company_id = ANY(v_companies);
  DELETE FROM public.journal_entry_rattelse_log WHERE company_id = ANY(v_companies);
  DELETE FROM public.account_reconciliation_attachments WHERE company_id = ANY(v_companies);
  -- signed_by is RESTRICT into auth.users.
  DELETE FROM public.account_reconciliations WHERE company_id = ANY(v_companies);
  -- Before documents: source_document_id is ON DELETE SET NULL and the guard
  -- refuses that UPDATE.
  DELETE FROM public.company_facts WHERE company_id = ANY(v_companies);
  -- Before journal entries: journal_entry_id is ON DELETE SET NULL and a
  -- booked trip refuses that UPDATE.
  DELETE FROM public.mileage_trips WHERE company_id = ANY(v_companies);
  -- Before fiscal periods (RESTRICT) and while the period rows still exist.
  DELETE FROM public.fiscal_period_tax_adjustments WHERE company_id = ANY(v_companies);

  -- Annual report: signature requests and submissions hold RESTRICT
  -- references to the versions, validation runs to versions and periods,
  -- versions to periods and the company.
  DELETE FROM public.arsredovisning_signature_requests WHERE company_id = ANY(v_companies);
  DELETE FROM public.annual_report_validation_runs WHERE company_id = ANY(v_companies);

  -- Documents: unlink from vouchers (block_document_deletion refuses a
  -- document on a posted voucher), detach the bank rows
  -- (transactions_document_id_fkey is RESTRICT; the detach is allowed once
  -- the document no longer sits on a voucher), then the deliveries that
  -- point at the sent PDF (RESTRICT, and block_sent_invoice_document_deletion),
  -- then the documents. The bank rows themselves stay for the companies
  -- cascade, as before: deleting them this early would rewrite every
  -- invoice and supplier invoice payment that points at one.
  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE company_id = ANY(v_companies);
  UPDATE public.transactions SET document_id = NULL
  WHERE company_id = ANY(v_companies) AND document_id IS NOT NULL;
  DELETE FROM public.invoice_deliveries WHERE company_id = ANY(v_companies);
  DELETE FROM public.document_attachments WHERE company_id = ANY(v_companies);

  -- Salary payment file archive (20260919105035): WORM with a teardown
  -- bypass that re-verifies through company_settings, and RESTRICT on
  -- salary_runs.
  DELETE FROM public.salary_payment_files WHERE company_id = ANY(v_companies);

  -- Registers that point at vouchers with RESTRICT or NO ACTION.
  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE company_id = ANY(v_companies);
  -- fiscal_periods points at its IB and bokslut vouchers with NO ACTION FKs,
  -- and previous_period_id chains periods to each other the same way.
  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = NULL,
      closing_entry_id = NULL,
      previous_period_id = NULL
  WHERE company_id = ANY(v_companies);
  -- Posted depreciation (RESTRICT; block_posted_depreciation_schedule_delete
  -- honours gnubok.allow_delete) and disposals (assets.disposal_journal_entry_id,
  -- RESTRICT). The schedules go first, then the register rows.
  DELETE FROM public.depreciation_schedules WHERE company_id = ANY(v_companies);
  DELETE FROM public.assets WHERE company_id = ANY(v_companies);
  DELETE FROM public.accrual_schedule_installments WHERE company_id = ANY(v_companies);
  DELETE FROM public.accrual_schedules WHERE company_id = ANY(v_companies);
  DELETE FROM public.vacation_year_closures WHERE company_id = ANY(v_companies);
  DELETE FROM public.agi_declarations WHERE company_id = ANY(v_companies);
  DELETE FROM public.stripe_payment_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.stripe_payouts WHERE company_id = ANY(v_companies);
  DELETE FROM public.webshop_orders WHERE company_id = ANY(v_companies);

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT je.id FROM public.journal_entries je WHERE je.company_id = ANY(v_companies)
  );
  DELETE FROM public.journal_entries WHERE company_id = ANY(v_companies);

  -- Betalfil batches: their items reference supplier_invoices with
  -- ON DELETE RESTRICT, so the batch headers go first (the items cascade).
  DELETE FROM public.supplier_payment_batches WHERE company_id = ANY(v_companies);
  -- Bokio supplier completion: entries hold NO ACTION references to the
  -- supplier invoices and to the work row, the work row to the company.
  DELETE FROM public.bokio_supplier_completion_entries WHERE company_id = ANY(v_companies);
  DELETE FROM public.bokio_supplier_completion_work WHERE company_id = ANY(v_companies);
  DELETE FROM public.supplier_invoices WHERE company_id = ANY(v_companies);

  -- Collections cases (20261012030200): the case trail is append-only and
  -- its teardown window re-verifies through company_settings, so it goes
  -- while those rows exist. The cases hold RESTRICT references to invoices
  -- and connections (deleted further down) and point at pending operations
  -- with SET NULL, so they go before all three.
  -- Payment forwards (20261012030400): a RESTRICT reference to their case,
  -- so they go first.
  DELETE FROM public.collection_payment_forwards WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_case_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_cases WHERE company_id = ANY(v_companies);

  DELETE FROM public.pending_operations WHERE company_id = ANY(v_companies);
  DELETE FROM public.dimensions WHERE company_id = ANY(v_companies);

  -- Journal references are gone. Delete import rows explicitly instead of
  -- relying on the cascade, whose settings-delete order is unknown.
  DELETE FROM public.sie_imports WHERE company_id = ANY(v_companies);
  -- Durable SIE jobs project terminal API operations: guarded, re-verified
  -- through company_settings.
  DELETE FROM public.operations WHERE company_id = ANY(v_companies);
  -- NO ACTION to companies, no cascade.
  DELETE FROM public.processing_history WHERE company_id = ANY(v_companies);
  -- Terminal webhook deliveries: guarded against DELETE.
  DELETE FROM public.webhook_deliveries WHERE company_id = ANY(v_companies);

  -- Rows that the companies cascade would otherwise reach in an order
  -- decided by trigger names: each holds a RESTRICT or NO ACTION reference
  -- to another row of the same company.
  DELETE FROM public.salary_line_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_payslip_deliveries WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_payslip_links WHERE company_id = ANY(v_companies);
  DELETE FROM public.salary_run_employees WHERE company_id = ANY(v_companies);
  DELETE FROM public.rot_rut_payout_request_items
  WHERE request_id IN (
    SELECT r.id FROM public.rot_rut_payout_requests r WHERE r.company_id = ANY(v_companies)
  );
  DELETE FROM public.recurring_invoice_schedules WHERE company_id = ANY(v_companies);
  -- Payment rows (20261012030300): a collected payment's delete guard
  -- re-verifies the sandbox through company_settings, so they go explicitly
  -- before the invoices cascade would take them.
  DELETE FROM public.invoice_payments WHERE company_id = ANY(v_companies);
  DELETE FROM public.invoices WHERE company_id = ANY(v_companies);
  DELETE FROM public.deadlines WHERE company_id = ANY(v_companies);
  DELETE FROM public.tax_assessment_notices WHERE company_id = ANY(v_companies);
  DELETE FROM public.annual_report_versions WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_job_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_jobs WHERE company_id = ANY(v_companies);
  DELETE FROM public.migration_source_records WHERE company_id = ANY(v_companies);

  -- Collections connections (20261012030100): the event trail is append-only
  -- and its teardown window re-verifies through company_settings, so it goes
  -- while those rows exist; the connections follow it.
  DELETE FROM public.collection_connection_events WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_connections WHERE company_id = ANY(v_companies);

  DELETE FROM public.audit_log WHERE company_id = ANY(v_companies);

  -- The companies themselves, before the account: every company-scoped row
  -- that references auth.users is gone before the account delete checks it.
  DELETE FROM public.companies WHERE id = ANY(v_companies);

  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
