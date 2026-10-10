-- pg-test: covered-by tests/pg/payment-orders.pg.test.ts
-- Payment orders: paying a supplier invoice from the company's own bank
-- account through a bank API (payment initiation, Open Payments first),
-- signed by the account holder with BankID.
--
-- Founder decision 2026-09-07 (DECISIONS.md, src/lib/supplier-invoices/
-- stages.ts): the supplier invoice lifecycle stays DERIVED, and payment
-- initiation "swaps its evidence, not its place". An invoice is "in payment"
-- when an open payment file batch OR an open payment order covers it, so this
-- migration adds no state to supplier_invoices. The instruction and what the
-- bank reports about it live here.
--
-- Why not rows in supplier_payment_batches: a batch is an immutable pain.001
-- snapshot (created -> cancelled only, no per-item state, NOT NULL file
-- fields). A bank-API payment has an execution lifecycle the bank reports
-- (awaiting signature, a second signer, accepted, executed, rejected), provider
-- ids and a signing basket. The two channels share the payee/reference
-- vocabulary and one rule, enforced in both directions below: an invoice is
-- never in an open file and an open order at the same time.
--
-- purpose is 'supplier_invoice' only today. Salary, tax and expense payouts
-- widen the CHECK and add their own nullable link column when they land.
--
-- Rules every writer follows, enforced below wherever a database can:
--   1. A payment is created at the bank at most once per order. The order is
--      claimed (submitted) before any bank call, and create_started_at is
--      written before each create (write-ahead): while it is set nothing may
--      move the order, and it is cleared only together with what the bank
--      answered (its payment id, a refusal, or an unknown outcome). A create
--      whose outcome is unknown (a timeout, a network error, a function killed
--      mid-create) leaves the order submitted with outcome_unknown_at set: it
--      still covers its invoice, and only its debit (by end-to-end id), the
--      bank's own id or a person resolves it. Nothing automatic fails, cancels
--      or re-approves it. A claimed order without the marker was never sent.
--   2. An order goes back to approved only when the bank holds nothing for
--      it: its create was refused or never sent, or its payment was cancelled
--      at the bank and the cancel confirmed (a provider_cancelled event names
--      the payment before its id may be cleared). When its invoice no longer
--      needs paying by then, it is cancelled instead.
--   3. Only server-side code writes. The functions below are executable by the
--      service role alone, called after the route authenticated the person
--      (MFA included) and passed as p_user_id, whose write role they check.
--      Members read their company's rows.
--   4. An order that reached a bank is kept (BFL 7 kap.): it cannot be
--      deleted, and its events are append-only.
--   5. Signing never starts for an invoice that no longer needs paying: the
--      claim and the restart re-check the invoices under lock, and an invoice
--      that closes while the bank holds an unsigned payment records an event;
--      the status sync then cancels that payment at the bank.

-- ---------------------------------------------------------------------------
-- 1. Payee as stated on the invoice document
-- ---------------------------------------------------------------------------
-- Today the invoice's own bankgiro/IBAN survives only in the inbox extraction
-- and in a file batch snapshot: supplier invoice creation back-fills the
-- supplier master and drops a giro that differs from it. Keeping what the
-- document says lets a payment compare it with the supplier's known account
-- (a changed account on an otherwise familiar invoice is the classic invoice
-- fraud) instead of silently paying the old one or the new one.
ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS payee_bankgiro text,
  ADD COLUMN IF NOT EXISTS payee_plusgiro text,
  ADD COLUMN IF NOT EXISTS payee_iban     text,
  ADD COLUMN IF NOT EXISTS payee_bic      text,
  ADD COLUMN IF NOT EXISTS payee_clearing text,
  ADD COLUMN IF NOT EXISTS payee_account  text;

COMMENT ON COLUMN public.supplier_invoices.payee_bankgiro IS
  'Bankgiro as stated on the invoice document (inbox extraction, Peppol PaymentMeans or typed). The supplier master (suppliers.bankgiro) holds the known default; a payment compares the two.';
COMMENT ON COLUMN public.supplier_invoices.payee_plusgiro IS
  'Plusgiro as stated on the invoice document. See payee_bankgiro.';
COMMENT ON COLUMN public.supplier_invoices.payee_iban IS
  'IBAN as stated on the invoice document. See payee_bankgiro.';
COMMENT ON COLUMN public.supplier_invoices.payee_bic IS
  'BIC as stated on the invoice document. See payee_bankgiro.';
COMMENT ON COLUMN public.supplier_invoices.payee_clearing IS
  'Clearing number as stated on the invoice document. See payee_bankgiro.';
COMMENT ON COLUMN public.supplier_invoices.payee_account IS
  'Bank account number as stated on the invoice document. See payee_bankgiro.';

-- ---------------------------------------------------------------------------
-- 2. Tables
-- ---------------------------------------------------------------------------

-- One signing: the orders a person signs with one BankID. With several orders
-- the bank sees a signing basket (signing_target 'basket', provider_batch_id
-- = the basket); with one order the payment itself is signed ('payment'). A
-- signing that was abandoned can be started again on the same row: the
-- authorisation id changes, the orders and the basket do not. When an order
-- drops out, the rest move to a new signing (rebatch_payment_orders_for_signing).
CREATE TABLE public.payment_order_batches (
  id                        uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider                  text NOT NULL CHECK (provider IN ('open_payments')),
  signing_target            text NOT NULL CHECK (signing_target IN ('payment', 'basket')),
  provider_batch_id         text,
  status                    text NOT NULL DEFAULT 'created' CHECK (status IN (
                              'created', 'awaiting_signature', 'awaiting_second_signer',
                              'signed', 'rejected', 'cancelled', 'failed')),
  provider_status           text,
  provider_status_at        timestamptz,
  -- The current BankID signing at the bank, and how it was offered. The
  -- authorisation id is also the attempt id: every restart replaces it.
  provider_authorisation_id text,
  signing_method            text CHECK (signing_method IN ('same_device', 'qr', 'redirect')),
  signer_user_id            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  signing_started_at        timestamptz,
  signed_at                 timestamptz,
  order_count               integer NOT NULL CHECK (order_count > 0),
  total_amount              numeric NOT NULL CHECK (total_amount > 0),
  currency                  text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_payment_order_batches_id_company UNIQUE (id, company_id),
  CONSTRAINT payment_order_batches_basket_needs_orders CHECK (signing_target = 'payment' OR order_count > 1),
  CONSTRAINT payment_order_batches_single_payment CHECK (signing_target = 'basket' OR order_count = 1)
);

CREATE TABLE public.payment_orders (
  id                        uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Who prepared the order (a person, or the owner of the API key an agent used).
  user_id                   uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  purpose                   text NOT NULL CHECK (purpose IN ('supplier_invoice')),
  supplier_invoice_id       uuid,
  batch_id                  uuid,
  status                    text NOT NULL DEFAULT 'draft' CHECK (status IN (
                              'draft', 'approved', 'submitted', 'awaiting_signature',
                              'awaiting_second_signer', 'accepted', 'executed',
                              'rejected', 'cancelled', 'failed')),

  -- The instruction. Frozen once the order leaves 'draft' (see the trigger).
  amount                    numeric NOT NULL CHECK (amount > 0),
  currency                  text NOT NULL DEFAULT 'SEK' CHECK (currency ~ '^[A-Z]{3}$'),
  requested_execution_date  date NOT NULL,
  -- Debtor: the company's own account the money leaves from, plus a snapshot
  -- {iban, bban, bic, name, currency, bank_name} so later edits to the cash
  -- account never change what was instructed.
  cash_account_id           uuid NOT NULL,
  debtor_snapshot           jsonb NOT NULL,
  payee_type                text NOT NULL CHECK (payee_type IN ('bankgiro', 'plusgiro', 'bank_account', 'iban')),
  payee_bankgiro            text,
  payee_plusgiro            text,
  payee_clearing            text,
  payee_account             text,
  payee_iban                text,
  payee_bic                 text,
  payee_name                text NOT NULL,
  -- Where the payee came from, and how it compares with what a person has
  -- already confirmed for the supplier. Derived by create_payment_orders,
  -- never taken from the caller: 'known' = an earlier payment instruction a
  -- person approved went to this account; 'new' = no person has confirmed it
  -- yet (first seen, or backfilled onto the card from this very invoice);
  -- 'changed' = the invoice states a different account than the supplier
  -- card. 'new' and 'changed' need a person's confirmation at approval.
  payee_source              text NOT NULL CHECK (payee_source IN ('invoice', 'supplier')),
  payee_check               text NOT NULL DEFAULT 'unchecked' CHECK (payee_check IN ('unchecked', 'known', 'new', 'changed')),
  reference_type            text NOT NULL CHECK (reference_type IN ('ocr', 'message')),
  reference                 text NOT NULL CHECK (length(reference) BETWEEN 1 AND 140),
  -- Our id for this payment at the bank (ISO 20022 EndToEndId, max 35 chars).
  -- The debit on the statement carries it, so the bank row matches the order
  -- without guessing. An order claimed again after its payment was cancelled
  -- or never sent gets a fresh one; its 'submitted' event keeps the earlier
  -- one, and settlement matches both.
  end_to_end_id             text NOT NULL DEFAULT ('ACC' || replace(gen_random_uuid()::text, '-', ''))
                              CHECK (length(end_to_end_id) BETWEEN 1 AND 35),
  idempotency_key           text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),

  -- What the bank said. provider is written once; provider_payment_id is
  -- written once and cleared only by the confirmed cancel of that payment.
  provider                  text CHECK (provider IN ('open_payments')),
  provider_payment_id       text,
  provider_payment_product  text,
  provider_status           text,
  -- When the bank was last asked. Polls refresh it; the audit log ignores it.
  provider_status_at        timestamptz,
  provider_error_code       text,
  -- A short sanitised text for people (no account numbers), never a raw error.
  provider_error_message    text,
  -- Written right before the bank is asked to create the payment, cleared
  -- with its answer (rule 1). Set means a create is in flight, or its caller
  -- died: the status sync turns an old one into outcome_unknown_at.
  create_started_at         timestamptz,
  -- The create may have reached the bank but we hold no payment id for it.
  -- Only on a submitted order without provider_payment_id; see rule 1.
  outcome_unknown_at        timestamptz,

  -- Who and when. Attest (approved) and signing are separate steps: an agent
  -- may prepare, a person approves, the account holder signs with BankID.
  approved_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at               timestamptz,
  submitted_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- Set by the claim and never cleared: an order that was ever claimed for a
  -- bank is kept even when it went back to approved.
  submitted_at              timestamptz,
  signed_at                 timestamptz,
  executed_at               timestamptz,
  cancelled_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at              timestamptz,

  -- Settlement: the bank row that shows the money leaving and the payment row
  -- that booked it against the invoice. Set by matching, only on an executed
  -- order. Undoing the match clears the payment row (a BEFORE DELETE trigger
  -- in 20261010090100, hence NO ACTION here) and reopens the order, unless
  -- another order covers the invoice by then: matched_at then stays, so the
  -- order is not "open" for the unique index but still covers the invoice.
  matched_transaction_id      uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  supplier_invoice_payment_id uuid REFERENCES public.supplier_invoice_payments(id) ON DELETE NO ACTION,
  matched_at                  timestamptz,

  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT uq_payment_orders_id_company UNIQUE (id, company_id),
  CONSTRAINT uq_payment_orders_idempotency UNIQUE (company_id, idempotency_key),
  CONSTRAINT uq_payment_orders_end_to_end UNIQUE (company_id, end_to_end_id),
  CONSTRAINT fk_payment_orders_supplier_invoice
    FOREIGN KEY (supplier_invoice_id, company_id)
    REFERENCES public.supplier_invoices (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_orders_cash_account
    FOREIGN KEY (cash_account_id, company_id)
    REFERENCES public.cash_accounts (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT fk_payment_orders_batch
    FOREIGN KEY (batch_id, company_id)
    REFERENCES public.payment_order_batches (id, company_id) ON DELETE RESTRICT,
  CONSTRAINT payment_orders_purpose_link CHECK (
    purpose <> 'supplier_invoice' OR supplier_invoice_id IS NOT NULL
  ),
  CONSTRAINT payment_orders_payee_fields_match CHECK (
    (payee_type = 'bankgiro' AND payee_bankgiro IS NOT NULL)
    OR (payee_type = 'plusgiro' AND payee_plusgiro IS NOT NULL)
    OR (payee_type = 'bank_account' AND payee_clearing IS NOT NULL AND payee_account IS NOT NULL)
    OR (payee_type = 'iban' AND payee_iban IS NOT NULL)
  ),
  -- Past 'approved' the bank has (or had) the payment: a provider must be named.
  CONSTRAINT payment_orders_provider_once_submitted CHECK (
    status IN ('draft', 'approved', 'cancelled', 'failed') OR provider IS NOT NULL
  ),
  CONSTRAINT payment_orders_settlement_only_when_executed CHECK (
    (matched_transaction_id IS NULL AND supplier_invoice_payment_id IS NULL AND matched_at IS NULL)
    OR status = 'executed'
  ),
  CONSTRAINT payment_orders_outcome_unknown_scope CHECK (
    outcome_unknown_at IS NULL OR (status = 'submitted' AND provider_payment_id IS NULL)
  ),
  CONSTRAINT payment_orders_create_in_flight_scope CHECK (
    create_started_at IS NULL
    OR (status = 'submitted' AND provider_payment_id IS NULL AND outcome_unknown_at IS NULL)
  )
);

-- One open order per invoice. "Open" includes an executed order whose debit
-- has not been matched yet: until the payment row exists, remaining_amount
-- still shows the invoice as unpaid, and a second order would pay it twice.
-- An executed order whose match was undone while another order covered the
-- invoice keeps matched_at and is not open here, so the two can coexist; it
-- still blocks new orders and files (create_payment_orders and
-- refuse_batch_item_for_invoice_in_payment check supplier_invoice_payment_id
-- alone).
CREATE UNIQUE INDEX uq_payment_orders_open_per_supplier_invoice
  ON public.payment_orders (supplier_invoice_id)
  WHERE supplier_invoice_id IS NOT NULL
    AND (status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                    'awaiting_second_signer', 'accepted')
         OR (status = 'executed' AND supplier_invoice_payment_id IS NULL AND matched_at IS NULL));

CREATE INDEX idx_payment_orders_company_status
  ON public.payment_orders (company_id, status);
CREATE INDEX idx_payment_orders_company_created
  ON public.payment_orders (company_id, created_at DESC);
CREATE INDEX idx_payment_orders_supplier_invoice_id
  ON public.payment_orders (supplier_invoice_id);
CREATE INDEX idx_payment_orders_batch_id
  ON public.payment_orders (batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_payment_orders_cash_account_id
  ON public.payment_orders (cash_account_id);
CREATE INDEX idx_payment_orders_provider_payment
  ON public.payment_orders (provider, provider_payment_id) WHERE provider_payment_id IS NOT NULL;
-- The status poll walks orders the bank has not finished with.
CREATE INDEX idx_payment_orders_in_flight
  ON public.payment_orders (provider_status_at NULLS FIRST)
  WHERE status IN ('submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted');
-- The stale-claim sweep walks claimed orders the bank has no id for.
CREATE INDEX idx_payment_orders_unsent_claims
  ON public.payment_orders (submitted_at)
  WHERE status = 'submitted' AND provider_payment_id IS NULL;
CREATE INDEX idx_payment_orders_matched_transaction
  ON public.payment_orders (matched_transaction_id) WHERE matched_transaction_id IS NOT NULL;
-- Every delete of a supplier payment row looks up the order it settled.
CREATE INDEX idx_payment_orders_supplier_invoice_payment
  ON public.payment_orders (supplier_invoice_payment_id) WHERE supplier_invoice_payment_id IS NOT NULL;
CREATE INDEX idx_payment_order_batches_company_created
  ON public.payment_order_batches (company_id, created_at DESC);

-- Append-only record of what happened to an order or batch and what the bank
-- said, raw. The audit trigger already keeps who changed which column; this
-- keeps the provider's own words next to it.
CREATE TABLE public.payment_order_events (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  payment_order_id uuid,
  batch_id         uuid,
  event_type       text NOT NULL CHECK (event_type IN (
                     'created', 'edited', 'approved', 'unapproved', 'submitted',
                     'signing_started', 'status_changed', 'cancel_requested',
                     'cancelled', 'matched', 'unmatched', 'error',
                     'outcome_unknown', 'provider_cancelled', 'released', 'rebatched',
                     'invoice_closed')),
  from_status      text,
  to_status        text,
  provider_status  text,
  actor_user_id    uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  detail           jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT payment_order_events_subject CHECK (payment_order_id IS NOT NULL OR batch_id IS NOT NULL),
  CONSTRAINT fk_payment_order_events_order
    FOREIGN KEY (payment_order_id, company_id)
    REFERENCES public.payment_orders (id, company_id) ON DELETE CASCADE,
  CONSTRAINT fk_payment_order_events_batch
    FOREIGN KEY (batch_id, company_id)
    REFERENCES public.payment_order_batches (id, company_id) ON DELETE CASCADE
);

CREATE INDEX idx_payment_order_events_order
  ON public.payment_order_events (payment_order_id, occurred_at) WHERE payment_order_id IS NOT NULL;
CREATE INDEX idx_payment_order_events_batch
  ON public.payment_order_events (batch_id, occurred_at) WHERE batch_id IS NOT NULL;
CREATE INDEX idx_payment_order_events_company
  ON public.payment_order_events (company_id, occurred_at DESC);

-- ---------------------------------------------------------------------------
-- 3. RLS and grants: members read, only server-side code writes
-- ---------------------------------------------------------------------------
ALTER TABLE public.payment_order_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.payment_order_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company payment_order_batches"
  ON public.payment_order_batches FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "view own-company payment_orders"
  ON public.payment_orders FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "view own-company payment_order_events"
  ON public.payment_order_events FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- No INSERT, UPDATE or DELETE policies: a payment instruction is money
-- leaving the company. The service-role functions and the payment service
-- are the only writers; a browser session cannot write these rows.

REVOKE ALL ON TABLE public.payment_order_batches FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.payment_orders FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.payment_order_events FROM PUBLIC, anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.payment_order_batches FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.payment_orders FROM authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.payment_order_events FROM authenticated;
GRANT SELECT ON TABLE public.payment_order_batches TO authenticated;
GRANT SELECT ON TABLE public.payment_orders TO authenticated;
GRANT SELECT ON TABLE public.payment_order_events TO authenticated;
GRANT ALL ON TABLE public.payment_order_batches TO service_role;
GRANT ALL ON TABLE public.payment_orders TO service_role;
GRANT ALL ON TABLE public.payment_order_events TO service_role;

-- ---------------------------------------------------------------------------
-- 4. Lifecycle: allowed status moves, a frozen instruction, write-once ids
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enforce_payment_order_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_allowed text[];
BEGIN
  -- Identity never changes.
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.purpose IS DISTINCT FROM OLD.purpose
     OR NEW.supplier_invoice_id IS DISTINCT FROM OLD.supplier_invoice_id
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_orders: identity columns are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  -- Except the end-to-end id of an order claimed again: a new payment gets a
  -- new id, once a 'submitted' event keeps the old one for settlement.
  IF NEW.end_to_end_id IS DISTINCT FROM OLD.end_to_end_id
     AND NOT (OLD.status = 'approved' AND NEW.status = 'submitted' AND OLD.submitted_at IS NOT NULL
              AND EXISTS (SELECT 1 FROM public.payment_order_events e
                           WHERE e.payment_order_id = OLD.id
                             AND e.company_id = OLD.company_id
                             AND e.event_type = 'submitted'
                             AND e.detail ->> 'previous_end_to_end_id' = OLD.end_to_end_id)) THEN
    RAISE EXCEPTION 'payment_orders: identity columns are immutable (the end-to-end id is renewed only by a new claim that keeps the old one)'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Rule 1, write-ahead: create_started_at is written right before the bank
  -- is asked to create the payment. While it is set the order stays where it
  -- is, and it is cleared only together with what the bank answered: the
  -- payment id, an unknown outcome, or a refusal or failure before sending,
  -- recorded as provider_error_code on the failed or released order.
  IF OLD.create_started_at IS NULL AND NEW.create_started_at IS NOT NULL THEN
    IF NOT (OLD.status = 'submitted' AND NEW.status = 'submitted'
            AND OLD.provider_payment_id IS NULL AND OLD.outcome_unknown_at IS NULL
            AND NEW.provider_error_code IS NULL
            AND NEW.batch_id IS NOT DISTINCT FROM OLD.batch_id) THEN
      RAISE EXCEPTION 'payment_orders: a create starts only on a claimed order the bank holds nothing for'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.create_started_at IS NOT NULL AND NEW.create_started_at IS NULL THEN
    IF NOT (NEW.provider_payment_id IS NOT NULL
            OR NEW.outcome_unknown_at IS NOT NULL
            OR (NEW.status IN ('approved', 'failed') AND NEW.provider_error_code IS NOT NULL)) THEN
      RAISE EXCEPTION 'payment_orders: a create in flight ends only with what the bank answered'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF OLD.create_started_at IS NOT NULL THEN
    IF NEW.create_started_at IS DISTINCT FROM OLD.create_started_at
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
      RAISE EXCEPTION 'payment_orders: nothing moves an order while its create is in flight'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The instruction is what a person attested and the bank received. It can
  -- only be edited while the order is a draft (un-approving an order moves it
  -- back to draft first, so the edit is attested again).
  IF OLD.status <> 'draft' AND (
       NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.currency IS DISTINCT FROM OLD.currency
       OR NEW.requested_execution_date IS DISTINCT FROM OLD.requested_execution_date
       OR NEW.cash_account_id IS DISTINCT FROM OLD.cash_account_id
       OR NEW.debtor_snapshot IS DISTINCT FROM OLD.debtor_snapshot
       OR NEW.payee_type IS DISTINCT FROM OLD.payee_type
       OR NEW.payee_bankgiro IS DISTINCT FROM OLD.payee_bankgiro
       OR NEW.payee_plusgiro IS DISTINCT FROM OLD.payee_plusgiro
       OR NEW.payee_clearing IS DISTINCT FROM OLD.payee_clearing
       OR NEW.payee_account IS DISTINCT FROM OLD.payee_account
       OR NEW.payee_iban IS DISTINCT FROM OLD.payee_iban
       OR NEW.payee_bic IS DISTINCT FROM OLD.payee_bic
       OR NEW.payee_name IS DISTINCT FROM OLD.payee_name
       OR NEW.payee_source IS DISTINCT FROM OLD.payee_source
       OR NEW.payee_check IS DISTINCT FROM OLD.payee_check
       OR NEW.reference_type IS DISTINCT FROM OLD.reference_type
       OR NEW.reference IS DISTINCT FROM OLD.reference) THEN
    RAISE EXCEPTION 'payment_orders: the instruction can only change while the order is a draft (status %)', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- A signing: an order joins one before the bank has it; a payment the bank
  -- already holds may move to a new signing (a basket signed again without an
  -- order that dropped out); going back to approved leaves the signing.
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id THEN
    IF OLD.status IN ('draft', 'approved') THEN
      NULL;
    ELSIF OLD.status = 'submitted' AND NEW.status = 'submitted'
          AND NEW.batch_id IS NOT NULL
          AND OLD.provider_payment_id IS NOT NULL
          AND NEW.provider_payment_id IS NOT DISTINCT FROM OLD.provider_payment_id THEN
      NULL;
    ELSIF OLD.status = 'submitted' AND NEW.status = 'approved' AND NEW.batch_id IS NULL THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'payment_orders: batch_id can only change before signing (status %)', OLD.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Provider identity is written once. The payment id may be cleared only on
  -- the way back to approved, after the bank confirmed the cancel of exactly
  -- that payment (rule 2).
  IF OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'payment_orders: provider is written once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    IF NOT (NEW.provider_payment_id IS NULL
            AND OLD.status = 'submitted' AND NEW.status = 'approved'
            AND EXISTS (SELECT 1 FROM public.payment_order_events e
                         WHERE e.payment_order_id = OLD.id
                           AND e.company_id = OLD.company_id
                           AND e.event_type = 'provider_cancelled'
                           AND e.detail ->> 'provider_payment_id' = OLD.provider_payment_id)) THEN
      RAISE EXCEPTION 'payment_orders: provider_payment_id is written once and cleared only after the bank confirmed its cancel'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- Rule 1: an outcome nobody knows is resolved by the debit, the bank's own
  -- id, or a person's cancel, never by an automatic failure or re-approval.
  IF OLD.outcome_unknown_at IS NOT NULL THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (NEW.status = 'executed' OR (NEW.status = 'cancelled' AND NEW.cancelled_by IS NOT NULL)) THEN
      RAISE EXCEPTION 'payment_orders: an order whose bank outcome is unknown is settled by its debit or cancelled by a person, not moved to %', NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.status = 'submitted' AND NEW.outcome_unknown_at IS NULL AND NEW.provider_payment_id IS NULL THEN
      RAISE EXCEPTION 'payment_orders: an unknown bank outcome is cleared only together with the bank''s payment id'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed := CASE OLD.status
      WHEN 'draft' THEN ARRAY['approved', 'cancelled']
      WHEN 'approved' THEN ARRAY['draft', 'submitted', 'cancelled', 'failed']
      -- Back to 'approved' only when the bank holds nothing (checked below).
      WHEN 'submitted' THEN ARRAY['approved', 'awaiting_signature', 'awaiting_second_signer', 'accepted',
                                  'executed', 'rejected', 'cancelled', 'failed']
      -- Back to 'submitted' when a BankID signing was abandoned or timed out:
      -- the payment still exists at the bank and can be signed again.
      WHEN 'awaiting_signature' THEN ARRAY['submitted', 'awaiting_second_signer', 'accepted',
                                           'executed', 'rejected', 'cancelled', 'failed']
      WHEN 'awaiting_second_signer' THEN ARRAY['accepted', 'executed', 'rejected', 'cancelled', 'failed']
      WHEN 'accepted' THEN ARRAY['executed', 'rejected', 'cancelled', 'failed']
      ELSE ARRAY[]::text[]  -- executed, rejected, cancelled, failed are final
    END;
    IF NOT (NEW.status = ANY(v_allowed)) THEN
      RAISE EXCEPTION 'payment_orders: status % cannot move to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'submitted' AND NEW.status = 'approved' AND NEW.provider_payment_id IS NOT NULL THEN
      RAISE EXCEPTION 'payment_orders: an order goes back to approved only when the bank holds no payment for it'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A claimed order without a payment id is cancelled only by a person,
    -- once its outcome is known to be unknown: a create in flight, or one
    -- that never started, ends on its own (rule 1).
    IF OLD.status = 'submitted' AND NEW.status = 'cancelled' AND NEW.provider_payment_id IS NULL
       AND NOT (OLD.outcome_unknown_at IS NOT NULL AND NEW.cancelled_by IS NOT NULL) THEN
      RAISE EXCEPTION 'payment_orders: a claimed order without a payment id is cancelled only by a person, once its bank outcome is unknown'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_payment_order_lifecycle
  BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_order_lifecycle();

CREATE OR REPLACE FUNCTION public.enforce_payment_order_batch_lifecycle()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
DECLARE
  v_allowed text[];
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.signing_target IS DISTINCT FROM OLD.signing_target
     OR NEW.order_count IS DISTINCT FROM OLD.order_count
     OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_order_batches: identity and totals are immutable'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_batch_id IS NOT NULL AND NEW.provider_batch_id IS DISTINCT FROM OLD.provider_batch_id THEN
    RAISE EXCEPTION 'payment_order_batches: provider_batch_id is written once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed := CASE OLD.status
      WHEN 'created' THEN ARRAY['awaiting_signature', 'awaiting_second_signer', 'signed',
                                'rejected', 'cancelled', 'failed']
      WHEN 'awaiting_signature' THEN ARRAY['created', 'awaiting_second_signer', 'signed',
                                           'rejected', 'cancelled', 'failed']
      WHEN 'awaiting_second_signer' THEN ARRAY['signed', 'rejected', 'cancelled', 'failed']
      ELSE ARRAY[]::text[]
    END;
    IF NOT (NEW.status = ANY(v_allowed)) THEN
      RAISE EXCEPTION 'payment_order_batches: status % cannot move to %', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_payment_order_batch_lifecycle
  BEFORE UPDATE ON public.payment_order_batches
  FOR EACH ROW EXECUTE FUNCTION public.enforce_payment_order_batch_lifecycle();

CREATE TRIGGER set_updated_at_payment_orders
  BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_updated_at_payment_order_batches
  BEFORE UPDATE ON public.payment_order_batches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- The audit log keeps every change of an order except a poll that only
-- refreshed when the bank was last asked (provider_status_at): an order in
-- flight is polled every 15 minutes, and those rows would be kept for years.
CREATE TRIGGER audit_payment_orders
  AFTER INSERT OR DELETE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER audit_payment_orders_update
  AFTER UPDATE ON public.payment_orders
  FOR EACH ROW
  WHEN (
    (to_jsonb(OLD) - ARRAY['provider_status_at', 'updated_at']::text[])
    IS DISTINCT FROM
    (to_jsonb(NEW) - ARRAY['provider_status_at', 'updated_at']::text[])
  )
  EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER audit_payment_order_batches
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_order_batches
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ---------------------------------------------------------------------------
-- 5. What is kept: orders that reached a bank, and every event
-- ---------------------------------------------------------------------------
-- An order that never left the app (never claimed for a bank, no payment id,
-- no signing) may be deleted, which is how a wrong supplier invoice can still
-- be deleted with its draft. Anything claimed for a bank is underlag for a
-- payment instruction and is kept, except in the sandbox teardown or a
-- sanctioned delete (gnubok.allow_delete).
CREATE OR REPLACE FUNCTION public.guard_payment_order_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.submitted_at IS NULL AND OLD.provider_payment_id IS NULL AND OLD.batch_id IS NULL
     AND OLD.status IN ('draft', 'approved', 'cancelled') THEN
    RETURN OLD;
  END IF;
  -- The teardown runs inside cleanup_sandbox_user (its owner is the current
  -- user there); a sandbox company never holds an order, so this is a window,
  -- not a path anything takes.
  IF current_setting('gnubok.allow_delete', true) = 'true'
     OR (current_setting('gnubok.sandbox_cleanup', true) = 'true'
         AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
                              WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'payment_orders: an order that was sent to a bank is kept (status %)', OLD.status
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER guard_payment_order_delete
  BEFORE DELETE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_order_delete();

-- Events are append-only. They go only together with their order or signing
-- (whose own guard decided), in the sandbox teardown, or in a sanctioned
-- delete.
CREATE OR REPLACE FUNCTION public.guard_payment_order_event_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF (OLD.payment_order_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM public.payment_orders po WHERE po.id = OLD.payment_order_id))
       OR (OLD.payment_order_id IS NULL AND OLD.batch_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.payment_order_batches b WHERE b.id = OLD.batch_id)) THEN
      RETURN OLD;
    END IF;
    IF current_setting('gnubok.allow_delete', true) = 'true'
       OR (current_setting('gnubok.sandbox_cleanup', true) = 'true'
           AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
                                WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)) THEN
      RETURN OLD;
    END IF;
  END IF;
  RAISE EXCEPTION 'payment_order_events are append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER guard_payment_order_event_change
  BEFORE UPDATE OR DELETE ON public.payment_order_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_payment_order_event_change();

CREATE OR REPLACE FUNCTION public.refuse_payment_order_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION '% cannot be truncated: payment history is kept', TG_TABLE_NAME
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER refuse_payment_orders_truncate
  BEFORE TRUNCATE ON public.payment_orders
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_payment_order_truncate();
CREATE TRIGGER refuse_payment_order_events_truncate
  BEFORE TRUNCATE ON public.payment_order_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.refuse_payment_order_truncate();

-- ---------------------------------------------------------------------------
-- 6. A file and a bank payment never cover the same invoice
-- ---------------------------------------------------------------------------
-- create_payment_orders() refuses an invoice sitting in an open file batch.
-- This trigger is the other direction: create_supplier_payment_batch() inserts
-- its items after locking the invoices FOR UPDATE, and create_payment_orders()
-- takes the same locks, so the check below sees any order committed by a
-- creator that held the lock first. An executed order covers its invoice
-- until its debit is matched, whatever matched_at says.
CREATE OR REPLACE FUNCTION public.refuse_batch_item_for_invoice_in_payment()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.payment_orders po
     WHERE po.supplier_invoice_id = NEW.supplier_invoice_id
       AND po.company_id = NEW.company_id
       AND (po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                          'awaiting_second_signer', 'accepted')
            OR (po.status = 'executed' AND po.supplier_invoice_payment_id IS NULL))
  ) THEN
    RAISE EXCEPTION 'supplier invoice % already has an open bank payment', NEW.supplier_invoice_id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER refuse_batch_item_for_invoice_in_payment
  BEFORE INSERT ON public.supplier_payment_batch_items
  FOR EACH ROW EXECUTE FUNCTION public.refuse_batch_item_for_invoice_in_payment();

-- ---------------------------------------------------------------------------
-- 7. An invoice that no longer needs paying cancels its unsent orders
-- ---------------------------------------------------------------------------
-- A draft or approved order has not been sent to a bank. When its invoice
-- becomes paid (another channel, a manual payment), credited or reversed, the
-- order would pay something nobody owes: it is cancelled with an event. An
-- order the bank holds, or may hold, is not touched here (cancelling it is a
-- bank call): it gets an 'invoice_closed' event, signing it again is refused
-- (the claim and rebatch re-check the invoice), and the status sync cancels
-- an unsigned payment at the bank. The invoice row is locked by this UPDATE
-- before the orders, the same order claim_payment_orders_for_signing locks
-- them in.
CREATE OR REPLACE FUNCTION public.cancel_open_payment_orders_for_closed_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  WITH cancelled AS (
    UPDATE public.payment_orders po
       SET status = 'cancelled',
           cancelled_at = now()
     WHERE po.company_id = NEW.company_id
       AND po.supplier_invoice_id = NEW.id
       AND po.status IN ('draft', 'approved')
    RETURNING po.id
  )
  INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, to_status, detail)
  SELECT NEW.company_id, cancelled.id, 'cancelled', 'cancelled',
         jsonb_build_object('reason', 'invoice_' || NEW.status)
    FROM cancelled;

  INSERT INTO public.payment_order_events (company_id, payment_order_id, batch_id, event_type, from_status, detail)
  SELECT po.company_id, po.id, po.batch_id, 'invoice_closed', po.status,
         jsonb_build_object('invoice_status', NEW.status, 'provider_payment_id', po.provider_payment_id)
    FROM public.payment_orders po
   WHERE po.company_id = NEW.company_id
     AND po.supplier_invoice_id = NEW.id
     AND po.status IN ('submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted');
  RETURN NEW;
END;
$$;

CREATE TRIGGER cancel_open_payment_orders_for_closed_invoice
  AFTER UPDATE OF status ON public.supplier_invoices
  FOR EACH ROW
  WHEN (NEW.status IN ('paid', 'credited', 'reversed') AND OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION public.cancel_open_payment_orders_for_closed_invoice();

REVOKE ALL ON FUNCTION public.cancel_open_payment_orders_for_closed_invoice() FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 8. Payee: the account an order pays, checked against what it claims to be
-- ---------------------------------------------------------------------------
-- One account as a comparable key: 'bankgiro:50501055', 'plusgiro:1234566',
-- 'bank_account:8327:123456789', 'iban:SE45...'. NULL when the fields of that
-- type are empty.
CREATE OR REPLACE FUNCTION public.payment_order_payee_key(
  p_type     text,
  p_bankgiro text,
  p_plusgiro text,
  p_clearing text,
  p_account  text,
  p_iban     text
)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $$
  SELECT CASE p_type
    WHEN 'bankgiro' THEN 'bankgiro:' || nullif(regexp_replace(coalesce(p_bankgiro, ''), '\D', '', 'g'), '')
    WHEN 'plusgiro' THEN 'plusgiro:' || nullif(regexp_replace(coalesce(p_plusgiro, ''), '\D', '', 'g'), '')
    WHEN 'bank_account' THEN 'bank_account:'
                             || nullif(regexp_replace(coalesce(p_clearing, ''), '\D', '', 'g'), '')
                             || ':' || nullif(regexp_replace(coalesce(p_account, ''), '\D', '', 'g'), '')
    WHEN 'iban' THEN 'iban:' || nullif(upper(regexp_replace(coalesce(p_iban, ''), '\s', '', 'g')), '')
  END
$$;

-- Whether a payee is what it says it is, and what a person has confirmed:
-- 'mismatch' when the account is not the one its source (the invoice
-- document or the supplier card) names; else 'changed' when the invoice
-- states a different account than the card; else 'known' when a person
-- approved an earlier order to this supplier and account and that order
-- reached the bank (it holds a payment id, or the bank confirmed its
-- cancel); else 'new'. Payment files do not count: nothing on a file batch
-- records whether a person or an API key created or downloaded it, and an
-- account an agent alone put in a file must not skip the confirmation. The
-- card's priority (bankgiro, plusgiro, clearing and account, a free-text
-- "8327-9 1234567") mirrors resolveSupplierPayee in
-- src/lib/payments/supplier-payee.ts.
CREATE OR REPLACE FUNCTION public.payment_order_payee_check(
  p_company_id          uuid,
  p_supplier_invoice_id uuid,
  p_payee_source        text,
  p_payee_type          text,
  p_bankgiro            text,
  p_plusgiro            text,
  p_clearing            text,
  p_account             text,
  p_iban                text
)
RETURNS text
LANGUAGE plpgsql
STABLE
SET search_path TO 'public'
AS $$
DECLARE
  v_chosen       text := public.payment_order_payee_key(p_payee_type, p_bankgiro, p_plusgiro, p_clearing, p_account, p_iban);
  v_invoice      public.supplier_invoices%ROWTYPE;
  v_supplier     public.suppliers%ROWTYPE;
  v_free         text[];
  v_card_free    text;
  v_invoice_same text;
  v_card_same    text;
  v_stated       text;
  v_card         text;
BEGIN
  SELECT * INTO v_invoice FROM public.supplier_invoices
   WHERE id = p_supplier_invoice_id AND company_id = p_company_id;
  IF NOT FOUND OR v_chosen IS NULL THEN
    RETURN 'mismatch';
  END IF;
  SELECT * INTO v_supplier FROM public.suppliers
   WHERE id = v_invoice.supplier_id AND company_id = p_company_id;

  v_free := regexp_match(btrim(coalesce(v_supplier.bank_account, '')), '^(\d{4}|8\d{4})[-\s]+([\d\s-]{5,15})$');
  v_card_free := CASE WHEN v_free IS NOT NULL
                      THEN 'bank_account:' || v_free[1] || ':' || regexp_replace(v_free[2], '\D', '', 'g') END;

  v_invoice_same := public.payment_order_payee_key(p_payee_type, v_invoice.payee_bankgiro, v_invoice.payee_plusgiro,
                                                   v_invoice.payee_clearing, v_invoice.payee_account, v_invoice.payee_iban);
  v_card_same := CASE WHEN p_payee_type = 'bank_account'
                      THEN coalesce(public.payment_order_payee_key('bank_account', NULL, NULL, v_supplier.clearing_number,
                                                                    v_supplier.account_number, NULL),
                                    v_card_free)
                      ELSE public.payment_order_payee_key(p_payee_type, v_supplier.bankgiro, v_supplier.plusgiro,
                                                          NULL, NULL, v_supplier.iban) END;

  -- coalesce: a source that names no account of this type compares as NULL,
  -- which must read as a mismatch, never as "not refused".
  IF NOT coalesce((p_payee_source = 'invoice' AND v_chosen = v_invoice_same)
                  OR (p_payee_source = 'supplier' AND v_chosen = v_card_same), false) THEN
    RETURN 'mismatch';
  END IF;

  v_stated := coalesce(
    public.payment_order_payee_key('bankgiro', v_invoice.payee_bankgiro, NULL, NULL, NULL, NULL),
    public.payment_order_payee_key('plusgiro', NULL, v_invoice.payee_plusgiro, NULL, NULL, NULL),
    public.payment_order_payee_key('bank_account', NULL, NULL, v_invoice.payee_clearing, v_invoice.payee_account, NULL),
    public.payment_order_payee_key('iban', NULL, NULL, NULL, NULL, v_invoice.payee_iban));
  v_card := coalesce(
    public.payment_order_payee_key('bankgiro', v_supplier.bankgiro, NULL, NULL, NULL, NULL),
    public.payment_order_payee_key('plusgiro', NULL, v_supplier.plusgiro, NULL, NULL, NULL),
    public.payment_order_payee_key('bank_account', NULL, NULL, v_supplier.clearing_number, v_supplier.account_number, NULL),
    v_card_free);

  IF v_stated IS NOT NULL AND v_card IS NOT NULL AND v_stated <> v_card THEN
    RETURN 'changed';
  END IF;

  -- approved_by is set only by a person's approval (a session route with MFA;
  -- an agent may prepare an order, never approve it).
  IF EXISTS (
       SELECT 1
         FROM public.payment_orders po
         JOIN public.supplier_invoices si ON si.id = po.supplier_invoice_id AND si.company_id = po.company_id
        WHERE po.company_id = p_company_id
          AND si.supplier_id = v_invoice.supplier_id
          AND po.approved_by IS NOT NULL
          AND (po.provider_payment_id IS NOT NULL
               OR EXISTS (SELECT 1 FROM public.payment_order_events e
                           WHERE e.payment_order_id = po.id
                             AND e.company_id = po.company_id
                             AND e.event_type = 'provider_cancelled'))
          AND public.payment_order_payee_key(po.payee_type, po.payee_bankgiro, po.payee_plusgiro,
                                             po.payee_clearing, po.payee_account, po.payee_iban) = v_chosen) THEN
    RETURN 'known';
  END IF;
  RETURN 'new';
END;
$$;

REVOKE ALL ON FUNCTION public.payment_order_payee_key(text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.payment_order_payee_check(uuid, uuid, text, text, text, text, text, text, text) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 9. create_payment_orders(): the one way to create orders
-- ---------------------------------------------------------------------------
-- p_orders is an array of objects with: supplier_invoice_id, amount, currency,
-- requested_execution_date, cash_account_id, debtor_snapshot, payee_type,
-- payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban,
-- payee_bic, payee_name, payee_source, reference_type, reference,
-- idempotency_key. payee_check is derived here, never read from the payload.
-- Orders are created as drafts. An idempotency_key already used in the
-- company returns the existing order, for the same invoice only.
--
-- Returns {ok: true, orders: [...]} or {ok: false, code, details} with code
-- one of: sandbox, invalid_payload, idempotency_mismatch, ineligible,
-- currency_mismatch, amount_exceeds_remaining, in_payment_file,
-- already_in_payment, payee_mismatch.
CREATE OR REPLACE FUNCTION public.create_payment_orders(
  p_company_id uuid,
  p_orders     jsonb,
  p_user_id    uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role      text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor         uuid := COALESCE(p_user_id, auth.uid());
  v_caller_role   text;
  v_ids           uuid[];
  v_new           jsonb;
  v_details       jsonb;
  v_created       jsonb;
  v_constraint    text;
BEGIN
  -- 1. Actor + tenant guard (same shape as create_supplier_payment_batch).
  --    Only the service role holds EXECUTE; the session branch stays as
  --    defence in depth.
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

  -- Never in a sandbox company. The service refuses first (isSandboxCompany
  -- in lib/payments/orders/prepare.ts); this holds for any caller too, since
  -- the sandbox teardown refuses on purpose to unwind a payment order.
  IF EXISTS (SELECT 1 FROM public.company_settings cs WHERE cs.company_id = p_company_id AND cs.is_sandbox) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'sandbox', 'details', 'bank payments are not available in a sandbox company');
  END IF;

  -- 2. Payload shape.
  IF jsonb_typeof(p_orders) IS DISTINCT FROM 'array' OR jsonb_array_length(p_orders) = 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload', 'details', 'no orders');
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_orders) x
     WHERE x ->> 'supplier_invoice_id' IS NULL OR x ->> 'idempotency_key' IS NULL
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload',
                              'details', 'supplier_invoice_id and idempotency_key are required');
  END IF;
  IF (SELECT count(DISTINCT x ->> 'idempotency_key') FROM jsonb_array_elements(p_orders) x)
     <> jsonb_array_length(p_orders) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload',
                              'details', 'each order needs its own idempotency_key');
  END IF;

  -- 3. Lock the invoices in id order before reading anything another writer
  --    could change: concurrent creators (orders or file batches), a claim
  --    and an undone match all take these rows first, so they queue on the
  --    first shared row instead of deadlocking or racing past a check.
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.company_id = p_company_id
      AND si.id IN (SELECT (x ->> 'supplier_invoice_id')::uuid FROM jsonb_array_elements(p_orders) x)
    ORDER BY si.id
    FOR UPDATE;

  -- 4. Replays: an existing idempotency_key returns its order, but only for
  --    the same invoice; a key reused for another invoice is a caller bug.
  SELECT jsonb_agg(jsonb_build_object('idempotency_key', po.idempotency_key, 'payment_order_id', po.id)) INTO v_details
    FROM jsonb_array_elements(p_orders) x
    JOIN public.payment_orders po
      ON po.company_id = p_company_id AND po.idempotency_key = x ->> 'idempotency_key'
   WHERE po.supplier_invoice_id IS DISTINCT FROM (x ->> 'supplier_invoice_id')::uuid;
  IF v_details IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'idempotency_mismatch', 'details', v_details);
  END IF;

  SELECT coalesce(jsonb_agg(x), '[]'::jsonb) INTO v_new
    FROM jsonb_array_elements(p_orders) x
   WHERE NOT EXISTS (
     SELECT 1 FROM public.payment_orders po
      WHERE po.company_id = p_company_id AND po.idempotency_key = x ->> 'idempotency_key'
   );

  IF jsonb_array_length(v_new) > 0 THEN
    SELECT array_agg(DISTINCT (x ->> 'supplier_invoice_id')::uuid) INTO v_ids
      FROM jsonb_array_elements(v_new) x;

    IF array_length(v_ids, 1) <> jsonb_array_length(v_new) THEN
      RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload',
                                'details', 'one order per supplier invoice');
    END IF;

    -- 5. Rechecks under the lock. The payable list matches
    --    PAYABLE_SUPPLIER_INVOICE_STATUSES (src/lib/payments/batch-eligibility.ts).
    SELECT jsonb_agg(jsonb_build_object('id', x.id, 'reason', 'not_found')) INTO v_details
      FROM unnest(v_ids) AS x(id)
     WHERE NOT EXISTS (
       SELECT 1 FROM public.supplier_invoices si WHERE si.id = x.id AND si.company_id = p_company_id
     );
    IF v_details IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ineligible', 'details', v_details);
    END IF;

    SELECT jsonb_agg(jsonb_build_object(
             'id', si.id,
             'reason', CASE WHEN si.is_credit_note THEN 'credit_note' ELSE 'not_payable' END))
      INTO v_details
      FROM public.supplier_invoices si
     WHERE si.company_id = p_company_id
       AND si.id = ANY(v_ids)
       AND (si.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue') OR si.is_credit_note);
    IF v_details IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'ineligible', 'details', v_details);
    END IF;

    SELECT jsonb_agg(jsonb_build_object('id', si.id, 'invoice_currency', si.currency)) INTO v_details
      FROM jsonb_array_elements(v_new) x
      JOIN public.supplier_invoices si
        ON si.id = (x ->> 'supplier_invoice_id')::uuid AND si.company_id = p_company_id
     WHERE upper(coalesce(x ->> 'currency', 'SEK')) <> upper(coalesce(si.currency, 'SEK'));
    IF v_details IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'currency_mismatch', 'details', v_details);
    END IF;

    SELECT jsonb_agg(jsonb_build_object('id', si.id)) INTO v_details
      FROM jsonb_array_elements(v_new) x
      JOIN public.supplier_invoices si
        ON si.id = (x ->> 'supplier_invoice_id')::uuid AND si.company_id = p_company_id
     WHERE (x ->> 'amount')::numeric > si.remaining_amount + 0.005;
    IF v_details IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'amount_exceeds_remaining', 'details', v_details);
    END IF;

    -- An open file batch: the batch is still 'created' and the invoice is not
    -- paid (a batch never closes by itself; payment is what settles it).
    SELECT jsonb_agg(jsonb_build_object('id', i.supplier_invoice_id, 'batch_id', b.id)) INTO v_details
      FROM public.supplier_payment_batch_items i
      JOIN public.supplier_payment_batches b ON b.id = i.batch_id AND b.company_id = i.company_id
      JOIN public.supplier_invoices si ON si.id = i.supplier_invoice_id AND si.company_id = i.company_id
     WHERE i.company_id = p_company_id
       AND i.supplier_invoice_id = ANY(v_ids)
       AND b.status = 'created'
       AND si.status <> 'paid';
    IF v_details IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'in_payment_file', 'details', v_details);
    END IF;

    -- An order that covers the invoice: open, or executed and not matched.
    SELECT jsonb_agg(jsonb_build_object('id', po.supplier_invoice_id, 'payment_order_id', po.id)) INTO v_details
      FROM public.payment_orders po
     WHERE po.company_id = p_company_id
       AND po.supplier_invoice_id = ANY(v_ids)
       AND (po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                          'awaiting_second_signer', 'accepted')
            OR (po.status = 'executed' AND po.supplier_invoice_payment_id IS NULL));
    IF v_details IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'already_in_payment', 'details', v_details);
    END IF;

    -- The payee must be the account its source names.
    SELECT jsonb_agg(jsonb_build_object('id', r.supplier_invoice_id)) INTO v_details
      FROM jsonb_to_recordset(v_new) AS r(
        supplier_invoice_id uuid, payee_source text, payee_type text, payee_bankgiro text,
        payee_plusgiro text, payee_clearing text, payee_account text, payee_iban text)
     WHERE public.payment_order_payee_check(p_company_id, r.supplier_invoice_id, r.payee_source, r.payee_type,
                                            r.payee_bankgiro, r.payee_plusgiro, r.payee_clearing,
                                            r.payee_account, r.payee_iban) = 'mismatch';
    IF v_details IS NOT NULL THEN
      RETURN jsonb_build_object('ok', false, 'code', 'payee_mismatch', 'details', v_details);
    END IF;

    -- 6. Insert. Table CHECKs (payee fields, reference length, currency shape)
    --    and the composite FKs (cash account in the same company) still fire
    --    and abort the whole call. The one-open-order index is the last word
    --    on a race the locks above did not see (an order reopened by a writer
    --    that skipped the invoice lock): a clean refusal, not an error.
    BEGIN
      WITH inserted AS (
        INSERT INTO public.payment_orders (
          company_id, user_id, purpose, supplier_invoice_id, status,
          amount, currency, requested_execution_date, cash_account_id, debtor_snapshot,
          payee_type, payee_bankgiro, payee_plusgiro, payee_clearing, payee_account,
          payee_iban, payee_bic, payee_name, payee_source, payee_check,
          reference_type, reference, idempotency_key)
        SELECT p_company_id, v_actor, 'supplier_invoice', r.supplier_invoice_id, 'draft',
               round(r.amount, 2), upper(coalesce(r.currency, 'SEK')), r.requested_execution_date,
               r.cash_account_id, r.debtor_snapshot,
               r.payee_type, r.payee_bankgiro, r.payee_plusgiro, r.payee_clearing, r.payee_account,
               r.payee_iban, r.payee_bic, r.payee_name, r.payee_source,
               public.payment_order_payee_check(p_company_id, r.supplier_invoice_id, r.payee_source, r.payee_type,
                                                r.payee_bankgiro, r.payee_plusgiro, r.payee_clearing,
                                                r.payee_account, r.payee_iban),
               r.reference_type, r.reference, r.idempotency_key
          FROM jsonb_to_recordset(v_new) AS r(
            supplier_invoice_id      uuid,
            amount                   numeric,
            currency                 text,
            requested_execution_date date,
            cash_account_id          uuid,
            debtor_snapshot          jsonb,
            payee_type               text,
            payee_bankgiro           text,
            payee_plusgiro           text,
            payee_clearing           text,
            payee_account            text,
            payee_iban               text,
            payee_bic                text,
            payee_name               text,
            payee_source             text,
            reference_type           text,
            reference                text,
            idempotency_key          text)
        RETURNING id
      )
      INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, to_status, actor_user_id)
      SELECT p_company_id, inserted.id, 'created', 'draft', v_actor FROM inserted;
    EXCEPTION WHEN unique_violation THEN
      GET STACKED DIAGNOSTICS v_constraint = CONSTRAINT_NAME;
      IF v_constraint = 'uq_payment_orders_open_per_supplier_invoice' THEN
        RETURN jsonb_build_object('ok', false, 'code', 'already_in_payment',
                                  'details', (SELECT jsonb_agg(jsonb_build_object('id', x)) FROM unnest(v_ids) AS x));
      END IF;
      RAISE;
    END;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(po) ORDER BY po.created_at, po.id), '[]'::jsonb) INTO v_created
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND po.idempotency_key IN (SELECT x ->> 'idempotency_key' FROM jsonb_array_elements(p_orders) x);

  RETURN jsonb_build_object('ok', true, 'orders', v_created);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_payment_orders(uuid, jsonb, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_payment_orders(uuid, jsonb, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 10. claim_payment_orders_for_signing(): approved orders -> one signing
-- ---------------------------------------------------------------------------
-- The step before anything is sent to the bank. All or nothing: every order
-- must exist in the company, be approved, leave from the same account in the
-- same currency (one BankID signs for one bank account), and still be owed:
-- the invoice may have been paid, credited or reduced since the order was
-- approved. The orders move to 'submitted' with the new signing batch in one
-- statement, so two people pressing "Signera" at once cannot both send the
-- same payment: a payment API without idempotency would create it twice.
--
-- Returns {ok: true, batch, orders} or {ok: false, code, details} with code
-- one of: invalid_payload, not_found, not_approved, mixed_accounts,
-- mixed_currency, ineligible.
CREATE OR REPLACE FUNCTION public.claim_payment_orders_for_signing(
  p_company_id uuid,
  p_order_ids  uuid[],
  p_provider   text,
  p_user_id    uuid DEFAULT NULL
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
  v_ids         uuid[];
  v_details     jsonb;
  v_count       integer;
  v_total       numeric;
  v_currency    text;
  v_batch       public.payment_order_batches%ROWTYPE;
  v_orders      jsonb;
BEGIN
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

  SELECT array_agg(DISTINCT x) INTO v_ids FROM unnest(p_order_ids) AS x WHERE x IS NOT NULL;
  IF v_ids IS NULL OR p_provider IS DISTINCT FROM 'open_payments' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload', 'details', 'orders and a known provider are required');
  END IF;

  -- Invoices first, then orders, the order every writer that touches both
  -- takes them in (an invoice UPDATE firing
  -- cancel_open_payment_orders_for_closed_invoice, create_payment_orders, the
  -- rebatch, the settlement triggers): two of them wait for each other in
  -- turn instead of each holding what the other needs.
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.company_id = p_company_id
      AND si.id IN (SELECT po.supplier_invoice_id FROM public.payment_orders po
                     WHERE po.company_id = p_company_id AND po.id = ANY(v_ids))
    ORDER BY si.id
    FOR UPDATE;
  PERFORM po.id
     FROM public.payment_orders po
    WHERE po.company_id = p_company_id AND po.id = ANY(v_ids)
    ORDER BY po.id
    FOR UPDATE;

  SELECT jsonb_agg(x.id) INTO v_details
    FROM unnest(v_ids) AS x(id)
   WHERE NOT EXISTS (SELECT 1 FROM public.payment_orders po WHERE po.id = x.id AND po.company_id = p_company_id);
  IF v_details IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'details', v_details);
  END IF;

  SELECT jsonb_agg(jsonb_build_object('id', po.id, 'status', po.status)) INTO v_details
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids) AND po.status <> 'approved';
  IF v_details IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_approved', 'details', v_details);
  END IF;

  IF (SELECT count(DISTINCT po.cash_account_id) FROM public.payment_orders po
       WHERE po.company_id = p_company_id AND po.id = ANY(v_ids)) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'mixed_accounts', 'details', 'one signing pays from one account');
  END IF;
  IF (SELECT count(DISTINCT po.currency) FROM public.payment_orders po
       WHERE po.company_id = p_company_id AND po.id = ANY(v_ids)) > 1 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'mixed_currency', 'details', 'one signing pays in one currency');
  END IF;

  -- Still owed: the payable list matches PAYABLE_SUPPLIER_INVOICE_STATUSES.
  SELECT jsonb_agg(jsonb_build_object(
           'id', po.id,
           'supplier_invoice_id', po.supplier_invoice_id,
           'reason', CASE WHEN si.is_credit_note THEN 'credit_note'
                          WHEN si.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue') THEN 'not_payable'
                          ELSE 'amount_exceeds_remaining' END))
    INTO v_details
    FROM public.payment_orders po
    JOIN public.supplier_invoices si ON si.id = po.supplier_invoice_id AND si.company_id = po.company_id
   WHERE po.company_id = p_company_id
     AND po.id = ANY(v_ids)
     AND (si.is_credit_note
          OR si.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue')
          OR po.amount > si.remaining_amount + 0.005);
  IF v_details IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ineligible', 'details', v_details);
  END IF;

  SELECT count(*), round(sum(po.amount), 2), min(po.currency)
    INTO v_count, v_total, v_currency
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  INSERT INTO public.payment_order_batches
    (company_id, user_id, provider, signing_target, status, order_count, total_amount, currency)
  VALUES
    (p_company_id, v_actor, p_provider, CASE WHEN v_count > 1 THEN 'basket' ELSE 'payment' END,
     'created', v_count, v_total, v_currency)
  RETURNING * INTO v_batch;

  -- An order claimed before (its payment cancelled at the bank, or never
  -- sent) gets a new end-to-end id: a bank may refuse a repeated one. The
  -- event keeps the old id first, so a debit that still carries it settles.
  INSERT INTO public.payment_order_events (company_id, payment_order_id, batch_id, event_type, from_status, to_status, actor_user_id, detail)
  SELECT p_company_id, po.id, v_batch.id, 'submitted', 'approved', 'submitted', v_actor,
         CASE WHEN po.submitted_at IS NOT NULL
              THEN jsonb_build_object('previous_end_to_end_id', po.end_to_end_id)
              ELSE '{}'::jsonb END
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  UPDATE public.payment_orders po
     SET status = 'submitted',
         provider = p_provider,
         batch_id = v_batch.id,
         submitted_by = v_actor,
         submitted_at = now(),
         end_to_end_id = CASE WHEN po.submitted_at IS NOT NULL
                              THEN 'ACC' || replace(gen_random_uuid()::text, '-', '')
                              ELSE po.end_to_end_id END,
         -- A new attempt starts without the last one's answer (rule 1).
         provider_error_code = NULL,
         provider_error_message = NULL
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  SELECT jsonb_agg(to_jsonb(po) ORDER BY po.id) INTO v_orders
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  RETURN jsonb_build_object('ok', true, 'batch', to_jsonb(v_batch), 'orders', v_orders);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_payment_orders_for_signing(uuid, uuid[], text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_payment_orders_for_signing(uuid, uuid[], text, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 11. rebatch_payment_orders_for_signing(): sign again without new payments
-- ---------------------------------------------------------------------------
-- A signing that did not finish leaves payments waiting, unsigned, at the
-- bank. Every restart comes through here, so the invoices are always checked
-- again under lock: a payment waiting at the bank is never signed for an
-- invoice that was paid, credited or reduced meanwhile. When every order is
-- still waiting, the same signing comes back unchanged (same: true) and
-- BankID starts on it again; when one dropped out (cancelled, refused) the
-- basket no longer matches, so the payments still waiting move to a new
-- signing (a new basket over the same payment ids, or the one payment
-- itself). Orders whose outcome is unknown have no payment id to sign and
-- stay where they are. While a create of the signing has not ended (in
-- flight, or never started by a request that died) nothing is signed: the
-- status sync settles those first.
--
-- Returns {ok: true, same, batch, orders} or {ok: false, code, details} with
-- code one of: not_found, not_active, create_in_progress, nothing_to_sign,
-- ineligible.
CREATE OR REPLACE FUNCTION public.rebatch_payment_orders_for_signing(
  p_company_id uuid,
  p_batch_id   uuid,
  p_user_id    uuid DEFAULT NULL
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
  v_old         public.payment_order_batches%ROWTYPE;
  v_ids         uuid[];
  v_all         integer;
  v_details     jsonb;
  v_count       integer;
  v_total       numeric;
  v_currency    text;
  v_batch       public.payment_order_batches%ROWTYPE;
  v_orders      jsonb;
BEGIN
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

  -- Invoices, then the signing, then its orders (the claim's lock order).
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.company_id = p_company_id
      AND si.id IN (SELECT po.supplier_invoice_id FROM public.payment_orders po
                     WHERE po.company_id = p_company_id AND po.batch_id = p_batch_id)
    ORDER BY si.id
    FOR UPDATE;
  SELECT * INTO v_old
    FROM public.payment_order_batches b
   WHERE b.id = p_batch_id AND b.company_id = p_company_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'details', p_batch_id);
  END IF;
  IF v_old.status NOT IN ('created', 'failed') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_active', 'details', v_old.status);
  END IF;
  PERFORM po.id
     FROM public.payment_orders po
    WHERE po.company_id = p_company_id AND po.batch_id = p_batch_id
    ORDER BY po.id
    FOR UPDATE;

  -- A claimed order with neither a payment id nor an unknown outcome: its
  -- create is in flight, or never started. Signing now could leave it behind
  -- in a signing that moves on without it.
  SELECT jsonb_agg(po.id ORDER BY po.id) INTO v_details
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND po.batch_id = p_batch_id
     AND po.status = 'submitted'
     AND po.provider_payment_id IS NULL
     AND po.outcome_unknown_at IS NULL;
  IF v_details IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'create_in_progress', 'details', v_details);
  END IF;

  SELECT array_agg(po.id ORDER BY po.id) INTO v_ids
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND po.batch_id = p_batch_id
     AND po.status = 'submitted'
     AND po.provider_payment_id IS NOT NULL
     AND po.outcome_unknown_at IS NULL;
  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'nothing_to_sign', 'details', p_batch_id);
  END IF;

  SELECT jsonb_agg(jsonb_build_object(
           'id', po.id,
           'supplier_invoice_id', po.supplier_invoice_id,
           'reason', CASE WHEN si.is_credit_note THEN 'credit_note'
                          WHEN si.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue') THEN 'not_payable'
                          ELSE 'amount_exceeds_remaining' END))
    INTO v_details
    FROM public.payment_orders po
    JOIN public.supplier_invoices si ON si.id = po.supplier_invoice_id AND si.company_id = po.company_id
   WHERE po.company_id = p_company_id
     AND po.id = ANY(v_ids)
     AND (si.is_credit_note
          OR si.status NOT IN ('registered', 'approved', 'partially_paid', 'overdue')
          OR po.amount > si.remaining_amount + 0.005);
  IF v_details IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'ineligible', 'details', v_details);
  END IF;

  -- Nothing dropped out and the bank has the signing target: the same signing.
  SELECT count(*) INTO v_all
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.batch_id = p_batch_id;
  IF v_old.status = 'created'
     AND array_length(v_ids, 1) = v_old.order_count
     AND v_all = v_old.order_count
     AND (v_old.signing_target = 'payment' OR v_old.provider_batch_id IS NOT NULL) THEN
    SELECT jsonb_agg(to_jsonb(po) ORDER BY po.id) INTO v_orders
      FROM public.payment_orders po
     WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);
    RETURN jsonb_build_object('ok', true, 'same', true, 'batch', to_jsonb(v_old), 'orders', v_orders);
  END IF;

  SELECT count(*), round(sum(po.amount), 2), min(po.currency)
    INTO v_count, v_total, v_currency
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  INSERT INTO public.payment_order_batches
    (company_id, user_id, provider, signing_target, status, order_count, total_amount, currency)
  VALUES
    (p_company_id, v_actor, v_old.provider, CASE WHEN v_count > 1 THEN 'basket' ELSE 'payment' END,
     'created', v_count, v_total, v_currency)
  RETURNING * INTO v_batch;

  UPDATE public.payment_orders po
     SET batch_id = v_batch.id
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  IF v_old.status = 'created' THEN
    UPDATE public.payment_order_batches SET status = 'cancelled' WHERE id = v_old.id;
  END IF;

  INSERT INTO public.payment_order_events (company_id, payment_order_id, batch_id, event_type, actor_user_id, detail)
  SELECT p_company_id, x, v_batch.id, 'rebatched', v_actor, jsonb_build_object('from_batch_id', v_old.id)
    FROM unnest(v_ids) AS x;

  SELECT jsonb_agg(to_jsonb(po) ORDER BY po.id) INTO v_orders
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  RETURN jsonb_build_object('ok', true, 'same', false, 'batch', to_jsonb(v_batch), 'orders', v_orders);
END;
$function$;

REVOKE ALL ON FUNCTION public.rebatch_payment_orders_for_signing(uuid, uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rebatch_payment_orders_for_signing(uuid, uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------
-- 12. release_payment_order(): the bank holds nothing, the order lets go
-- ---------------------------------------------------------------------------
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

  -- Rule 2: nothing left to pay means nothing left to sign.
  v_reason := CASE
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

-- ---------------------------------------------------------------------------
-- 13. sweep_stale_payment_order_claims(): claims nobody finished
-- ---------------------------------------------------------------------------
-- Run by the status sync. A claimed order whose create started before
-- p_before and never got the bank's answer (its request died, rule 1) is
-- marked outcome unknown: the bank may hold its payment. A claimed order
-- whose create never started before p_before was never sent (the marker is
-- written first) and is released like any other. State and event are
-- written together. p_before lies further back than any request can run
-- (the signing routes stop at their maxDuration), so a live create is never
-- swept.
--
-- Returns {marked_unknown, released}.
CREATE OR REPLACE FUNCTION public.sweep_stale_payment_order_claims(p_before timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_ids      uuid[];
  v_batches  uuid[];
  v_unknown  integer := 0;
  v_released integer := 0;
  v_order    public.payment_orders%ROWTYPE;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'unauthorized: stale claims are swept by the server only' USING ERRCODE = '42501';
  END IF;
  IF p_before IS NULL OR p_before > now() - interval '10 minutes' THEN
    RAISE EXCEPTION 'sweep_stale_payment_order_claims: p_before must lie at least 10 minutes back'
      USING ERRCODE = 'invalid_parameter_value';
  END IF;

  SELECT array_agg(po.id), array_agg(DISTINCT po.batch_id) INTO v_ids, v_batches
    FROM public.payment_orders po
   WHERE po.status = 'submitted'
     AND po.provider_payment_id IS NULL
     AND po.outcome_unknown_at IS NULL
     AND (po.create_started_at < p_before
          OR (po.create_started_at IS NULL AND po.submitted_at < p_before));
  IF v_ids IS NULL THEN
    RETURN jsonb_build_object('marked_unknown', 0, 'released', 0);
  END IF;

  -- Invoices, then orders (the claim's lock order).
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.id IN (SELECT po.supplier_invoice_id FROM public.payment_orders po WHERE po.id = ANY(v_ids))
    ORDER BY si.id
    FOR UPDATE;
  PERFORM po.id
     FROM public.payment_orders po
    WHERE po.id = ANY(v_ids)
    ORDER BY po.id
    FOR UPDATE;

  WITH marked AS (
    UPDATE public.payment_orders po
       SET outcome_unknown_at = now(),
           create_started_at = NULL,
           provider_error_code = 'CREATE_NOT_FINISHED'
     WHERE po.id = ANY(v_ids)
       AND po.status = 'submitted'
       AND po.provider_payment_id IS NULL
       AND po.outcome_unknown_at IS NULL
       AND po.create_started_at < p_before
    RETURNING po.id, po.company_id, po.batch_id
  ), logged AS (
    INSERT INTO public.payment_order_events (company_id, payment_order_id, batch_id, event_type, detail)
    SELECT m.company_id, m.id, m.batch_id, 'outcome_unknown',
           jsonb_build_object('code', 'CREATE_NOT_FINISHED', 'source', 'status_sync')
      FROM marked m
    RETURNING 1
  )
  SELECT count(*) INTO v_unknown FROM logged;

  FOR v_order IN
    SELECT * FROM public.payment_orders po
     WHERE po.id = ANY(v_ids)
       AND po.status = 'submitted'
       AND po.provider_payment_id IS NULL
       AND po.outcome_unknown_at IS NULL
       AND po.create_started_at IS NULL
       AND po.submitted_at < p_before
     ORDER BY po.id
  LOOP
    IF (public.release_payment_order(v_order.company_id, v_order.id, v_order.batch_id, NULL, NULL,
                                     'CREATE_NEVER_STARTED') ->> 'ok')::boolean THEN
      v_released := v_released + 1;
    END IF;
  END LOOP;

  -- A signing left without any order ends.
  UPDATE public.payment_order_batches b
     SET status = 'failed'
   WHERE b.id = ANY(v_batches)
     AND b.status = 'created'
     AND NOT EXISTS (SELECT 1 FROM public.payment_orders po WHERE po.batch_id = b.id);

  RETURN jsonb_build_object('marked_unknown', v_unknown, 'released', v_released);
END;
$function$;

REVOKE ALL ON FUNCTION public.sweep_stale_payment_order_claims(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.sweep_stale_payment_order_claims(timestamptz) TO service_role;

-- ---------------------------------------------------------------------------
-- 14. resolve_payment_order(): a person settles what the bank cannot tell
-- ---------------------------------------------------------------------------
-- For an order held (its outcome unknown) or stranded (the bank cannot be
-- asked, or no longer knows the payment). Only the payments session route
-- calls this, for a person signed in with MFA; it has no machine door
-- (session-route-parity: ui-only), so an agent never resolves an order.
--   'not_at_bank': the person confirms the payment never reached the bank or
--     no longer exists there. For an order whose outcome is unknown (no
--     payment id), or one with a payment id when the bank was asked and
--     answered not found, or no provider can be asked (p_bank_answer
--     'not_found' or 'no_provider'). The order is cancelled.
--   'paid': the person confirms the bank paid it and names the payment row
--     on the invoice that booked it (the same amount within one öre, not
--     settling another order). The order settles against that row.
-- Never for an order mid-signing (awaiting_signature), nor for a create in
-- flight or never started (the status sync settles those).
--
-- Returns {ok: true, status} or {ok: false, code, details} with code one of:
-- invalid_payload, not_found, not_resolvable, payment_not_found,
-- payment_mismatch.
CREATE OR REPLACE FUNCTION public.resolve_payment_order(
  p_company_id                  uuid,
  p_order_id                    uuid,
  p_resolution                  text,
  p_user_id                     uuid,
  p_bank_answer                 text DEFAULT NULL,
  p_supplier_invoice_payment_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_jwt_role    text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_actor       uuid := p_user_id;
  v_caller_role text;
  v_order       public.payment_orders%ROWTYPE;
  v_payment     public.supplier_invoice_payments%ROWTYPE;
  v_answer      text;
BEGIN
  IF v_jwt_role IN ('anon', 'authenticated') THEN
    RAISE EXCEPTION 'unauthorized: payment orders are resolved through the server only' USING ERRCODE = '42501';
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
  IF p_resolution IS NULL OR p_resolution NOT IN ('not_at_bank', 'paid')
     OR (p_resolution = 'paid' AND p_supplier_invoice_payment_id IS NULL) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'invalid_payload', 'details', 'resolution not_at_bank, or paid with a payment row');
  END IF;

  -- The invoice before the order (the claim's lock order).
  PERFORM si.id
     FROM public.supplier_invoices si
    WHERE si.company_id = p_company_id
      AND si.id = (SELECT po.supplier_invoice_id FROM public.payment_orders po
                    WHERE po.id = p_order_id AND po.company_id = p_company_id)
      FOR UPDATE;
  SELECT * INTO v_order
    FROM public.payment_orders po
   WHERE po.id = p_order_id AND po.company_id = p_company_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_found', 'details', p_order_id);
  END IF;

  IF p_resolution = 'not_at_bank' THEN
    IF v_order.status = 'submitted' AND v_order.provider_payment_id IS NULL AND v_order.outcome_unknown_at IS NOT NULL THEN
      v_answer := 'outcome_unknown';
      UPDATE public.payment_orders
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor, outcome_unknown_at = NULL
       WHERE id = p_order_id;
    ELSIF v_order.provider_payment_id IS NOT NULL
          AND v_order.status IN ('submitted', 'awaiting_second_signer', 'accepted')
          AND p_bank_answer IN ('not_found', 'no_provider') THEN
      v_answer := p_bank_answer;
      UPDATE public.payment_orders
         SET status = 'cancelled', cancelled_at = now(), cancelled_by = v_actor
       WHERE id = p_order_id;
    ELSE
      RETURN jsonb_build_object('ok', false, 'code', 'not_resolvable',
                                'details', jsonb_build_object('status', v_order.status,
                                                              'has_payment_id', v_order.provider_payment_id IS NOT NULL,
                                                              'outcome_unknown', v_order.outcome_unknown_at IS NOT NULL));
    END IF;
    INSERT INTO public.payment_order_events
      (company_id, payment_order_id, event_type, from_status, to_status, actor_user_id, detail)
    VALUES
      (p_company_id, p_order_id, 'cancelled', v_order.status, 'cancelled', v_actor,
       jsonb_strip_nulls(jsonb_build_object('resolution', 'not_at_bank', 'by', 'person', 'bank_answer', v_answer,
                                            'provider_payment_id', v_order.provider_payment_id)));
    RETURN jsonb_build_object('ok', true, 'status', 'cancelled');
  END IF;

  -- 'paid'
  IF NOT ((v_order.status = 'submitted' AND (v_order.provider_payment_id IS NOT NULL OR v_order.outcome_unknown_at IS NOT NULL))
          OR v_order.status IN ('awaiting_second_signer', 'accepted')
          OR (v_order.status = 'executed' AND v_order.supplier_invoice_payment_id IS NULL)) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'not_resolvable',
                              'details', jsonb_build_object('status', v_order.status,
                                                            'has_payment_id', v_order.provider_payment_id IS NOT NULL,
                                                            'outcome_unknown', v_order.outcome_unknown_at IS NOT NULL));
  END IF;
  SELECT * INTO v_payment
    FROM public.supplier_invoice_payments p
   WHERE p.id = p_supplier_invoice_payment_id AND p.company_id = p_company_id;
  IF NOT FOUND OR v_payment.supplier_invoice_id IS DISTINCT FROM v_order.supplier_invoice_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_not_found', 'details', p_supplier_invoice_payment_id);
  END IF;
  IF abs(v_payment.amount - v_order.amount) > 0.01
     OR EXISTS (SELECT 1 FROM public.payment_orders po WHERE po.supplier_invoice_payment_id = v_payment.id) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'payment_mismatch', 'details', p_supplier_invoice_payment_id);
  END IF;

  UPDATE public.payment_orders
     SET status = 'executed',
         executed_at = coalesce(executed_at, now()),
         outcome_unknown_at = NULL,
         supplier_invoice_payment_id = v_payment.id,
         matched_transaction_id = v_payment.transaction_id,
         matched_at = now()
   WHERE id = p_order_id;
  INSERT INTO public.payment_order_events
    (company_id, payment_order_id, event_type, from_status, to_status, actor_user_id, detail)
  VALUES
    (p_company_id, p_order_id, 'matched', v_order.status, 'executed', v_actor,
     jsonb_build_object('supplier_invoice_payment_id', v_payment.id, 'transaction_id', v_payment.transaction_id,
                        'by', 'person', 'resolution', 'paid'));
  RETURN jsonb_build_object('ok', true, 'status', 'executed');
END;
$function$;

REVOKE ALL ON FUNCTION public.resolve_payment_order(uuid, uuid, text, uuid, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_payment_order(uuid, uuid, text, uuid, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
