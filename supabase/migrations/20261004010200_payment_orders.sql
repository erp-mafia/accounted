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
-- Writes happen server-side only: create_payment_orders() (SECURITY DEFINER,
-- member write role checked in the database) and service-role updates from the
-- payment service after the bank answers. Members read their company's rows.
-- The lifecycle trigger below is the contract for every writer.

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
-- authorisation id changes, the orders and the basket do not.
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
  -- The current BankID signing at the bank, and how it was offered.
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
  -- Where the payee came from, and how it compared with what we know about
  -- the supplier when the order was prepared: 'known' = the account the
  -- supplier master or an earlier payment already had; 'new' = the supplier
  -- had no account on file; 'changed' = the invoice states a different account
  -- than the supplier master. 'changed' is the one a person must look at.
  payee_source              text NOT NULL CHECK (payee_source IN ('invoice', 'supplier')),
  payee_check               text NOT NULL DEFAULT 'unchecked' CHECK (payee_check IN ('unchecked', 'known', 'new', 'changed')),
  reference_type            text NOT NULL CHECK (reference_type IN ('ocr', 'message')),
  reference                 text NOT NULL CHECK (length(reference) BETWEEN 1 AND 140),
  -- Our id for this payment at the bank (ISO 20022 EndToEndId, max 35 chars).
  -- The debit on the statement carries it, so the bank row matches the order
  -- without guessing.
  end_to_end_id             text NOT NULL DEFAULT ('ACC' || replace(gen_random_uuid()::text, '-', ''))
                              CHECK (length(end_to_end_id) BETWEEN 1 AND 35),
  idempotency_key           text NOT NULL CHECK (length(idempotency_key) BETWEEN 1 AND 200),

  -- What the bank said. provider/provider_payment_id are written once.
  provider                  text CHECK (provider IN ('open_payments')),
  provider_payment_id       text,
  provider_payment_product  text,
  provider_status           text,
  provider_status_at        timestamptz,
  provider_error_code       text,
  provider_error_message    text,

  -- Who and when. Attest (approved) and signing are separate steps: an agent
  -- may prepare, a person approves, the account holder signs with BankID.
  approved_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_at               timestamptz,
  submitted_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  submitted_at              timestamptz,
  signed_at                 timestamptz,
  executed_at               timestamptz,
  cancelled_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  cancelled_at              timestamptz,

  -- Settlement: the bank row that shows the money leaving and the payment row
  -- that booked it against the invoice. Set by matching, only on an executed
  -- order; cleared again when that match is undone.
  matched_transaction_id      uuid REFERENCES public.transactions(id) ON DELETE SET NULL,
  supplier_invoice_payment_id uuid REFERENCES public.supplier_invoice_payments(id) ON DELETE SET NULL,
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
  )
);

-- One open order per invoice. "Open" includes an executed order whose debit
-- has not been matched yet: until the payment row exists, remaining_amount
-- still shows the invoice as unpaid, and a second order would pay it twice.
CREATE UNIQUE INDEX uq_payment_orders_open_per_supplier_invoice
  ON public.payment_orders (supplier_invoice_id)
  WHERE supplier_invoice_id IS NOT NULL
    AND (status IN ('draft', 'approved', 'submitted', 'awaiting_signature',
                    'awaiting_second_signer', 'accepted')
         OR (status = 'executed' AND supplier_invoice_payment_id IS NULL));

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
CREATE INDEX idx_payment_orders_matched_transaction
  ON public.payment_orders (matched_transaction_id) WHERE matched_transaction_id IS NOT NULL;
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
                     'cancelled', 'matched', 'unmatched', 'error')),
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
-- leaving the company. create_payment_orders() and the service-role payment
-- service are the only writers; a browser session cannot write these rows.

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
     OR NEW.end_to_end_id IS DISTINCT FROM OLD.end_to_end_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'payment_orders: identity columns are immutable'
      USING ERRCODE = 'check_violation';
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

  -- An order joins a signing batch before the bank has it, never after.
  IF NEW.batch_id IS DISTINCT FROM OLD.batch_id AND OLD.status NOT IN ('draft', 'approved') THEN
    RAISE EXCEPTION 'payment_orders: batch_id can only change before submission (status %)', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- Provider identity is written once.
  IF OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'payment_orders: provider is written once'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.provider_payment_id IS NOT NULL AND NEW.provider_payment_id IS DISTINCT FROM OLD.provider_payment_id THEN
    RAISE EXCEPTION 'payment_orders: provider_payment_id is written once'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.status IS DISTINCT FROM OLD.status THEN
    v_allowed := CASE OLD.status
      WHEN 'draft' THEN ARRAY['approved', 'cancelled']
      WHEN 'approved' THEN ARRAY['draft', 'submitted', 'cancelled', 'failed']
      WHEN 'submitted' THEN ARRAY['awaiting_signature', 'awaiting_second_signer', 'accepted',
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

-- Events are append-only.
CREATE OR REPLACE FUNCTION public.block_payment_order_event_update()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  RAISE EXCEPTION 'payment_order_events are append-only'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER block_payment_order_event_update
  BEFORE UPDATE ON public.payment_order_events
  FOR EACH ROW EXECUTE FUNCTION public.block_payment_order_event_update();

CREATE TRIGGER set_updated_at_payment_orders
  BEFORE UPDATE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
CREATE TRIGGER set_updated_at_payment_order_batches
  BEFORE UPDATE ON public.payment_order_batches
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_payment_orders
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_orders
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();
CREATE TRIGGER audit_payment_order_batches
  AFTER INSERT OR UPDATE OR DELETE ON public.payment_order_batches
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- ---------------------------------------------------------------------------
-- 5. A file and a bank payment never cover the same invoice
-- ---------------------------------------------------------------------------
-- create_payment_orders() refuses an invoice sitting in an open file batch.
-- This trigger is the other direction: create_supplier_payment_batch() inserts
-- its items after locking the invoices FOR UPDATE, and create_payment_orders()
-- takes the same locks, so the check below sees any order committed by a
-- creator that held the lock first.
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
-- 6. create_payment_orders(): the one way to create orders
-- ---------------------------------------------------------------------------
-- p_orders is an array of objects with: supplier_invoice_id, amount, currency,
-- requested_execution_date, cash_account_id, debtor_snapshot, payee_type,
-- payee_bankgiro, payee_plusgiro, payee_clearing, payee_account, payee_iban,
-- payee_bic, payee_name, payee_source, payee_check, reference_type, reference,
-- idempotency_key. Orders are created as drafts. An idempotency_key already
-- used in the company returns the existing order instead of a second one.
--
-- Returns {ok: true, orders: [...]} or {ok: false, code, details} with code
-- one of: sandbox, invalid_payload, ineligible, currency_mismatch,
-- amount_exceeds_remaining, in_payment_file, already_in_payment.
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
BEGIN
  -- 1. Actor + tenant guard (same shape as create_supplier_payment_batch).
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
  -- in lib/payments/orders/prepare.ts); this holds for a direct RPC call too,
  -- since the sandbox teardown refuses on purpose to unwind a payment order.
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

  -- 3. Replays: orders whose idempotency_key already exists are returned as
  --    they are, the rest continue.
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

    -- 4. Lock the invoices in id order: concurrent creators (orders or file
    --    batches) queue on the first shared row instead of deadlocking.
    PERFORM si.id
       FROM public.supplier_invoices si
      WHERE si.company_id = p_company_id AND si.id = ANY(v_ids)
      ORDER BY si.id
      FOR UPDATE;

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

    -- 6. Insert. Table CHECKs (payee fields, reference length, currency shape)
    --    and the composite FKs (cash account in the same company) still fire
    --    and abort the whole call.
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
             r.payee_iban, r.payee_bic, r.payee_name, r.payee_source, coalesce(r.payee_check, 'unchecked'),
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
          payee_check              text,
          reference_type           text,
          reference                text,
          idempotency_key          text)
      RETURNING id
    )
    INSERT INTO public.payment_order_events (company_id, payment_order_id, event_type, to_status, actor_user_id)
    SELECT p_company_id, inserted.id, 'created', 'draft', v_actor FROM inserted;
  END IF;

  SELECT coalesce(jsonb_agg(to_jsonb(po) ORDER BY po.created_at, po.id), '[]'::jsonb) INTO v_created
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id
     AND po.idempotency_key IN (SELECT x ->> 'idempotency_key' FROM jsonb_array_elements(p_orders) x);

  RETURN jsonb_build_object('ok', true, 'orders', v_created);
END;
$function$;

REVOKE ALL ON FUNCTION public.create_payment_orders(uuid, jsonb, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_payment_orders(uuid, jsonb, uuid) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. claim_payment_orders_for_signing(): approved orders -> one signing
-- ---------------------------------------------------------------------------
-- The step before anything is sent to the bank. All or nothing: every order
-- must exist in the company, be approved, and leave from the same account in
-- the same currency (one BankID signs for one bank account). The orders move
-- to 'submitted' with the new signing batch in one statement, so two people
-- pressing "Signera" at once cannot both send the same payment: a payment API
-- without idempotency would create it twice.
--
-- Returns {ok: true, batch, orders} or {ok: false, code, details} with code
-- one of: invalid_payload, not_found, not_approved, mixed_accounts,
-- mixed_currency.
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

  UPDATE public.payment_orders po
     SET status = 'submitted',
         provider = p_provider,
         batch_id = v_batch.id,
         submitted_by = v_actor,
         submitted_at = now()
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  INSERT INTO public.payment_order_events (company_id, payment_order_id, batch_id, event_type, from_status, to_status, actor_user_id)
  SELECT p_company_id, x, v_batch.id, 'submitted', 'approved', 'submitted', v_actor FROM unnest(v_ids) AS x;

  SELECT jsonb_agg(to_jsonb(po) ORDER BY po.id) INTO v_orders
    FROM public.payment_orders po
   WHERE po.company_id = p_company_id AND po.id = ANY(v_ids);

  RETURN jsonb_build_object('ok', true, 'batch', to_jsonb(v_batch), 'orders', v_orders);
END;
$function$;

REVOKE ALL ON FUNCTION public.claim_payment_orders_for_signing(uuid, uuid[], text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_payment_orders_for_signing(uuid, uuid[], text, uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
