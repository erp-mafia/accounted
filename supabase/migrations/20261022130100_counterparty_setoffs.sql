-- Kvittning (set-off) of a customer invoice against a supplier invoice of the
-- same counterparty (crm#1367).
-- pg-test: tests/pg/counterparty-setoff.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts,
--          tests/pg/pending-operations-op-type-audit.pg.test.ts,
--          tests/pg/definer-function-grants.pg.test.ts
--
-- A company that both sells to and buys from the same legal person (one
-- party, lib/parties) settles the two debts against each other and pays or
-- receives only the net. The set-off is a business event of its own and gets
-- a verifikat of its own (source_type counterparty_setoff), in one SQL
-- transaction with everything it changes:
--
--   Dr the accounts payable account the supplier invoice's registration
--      voucher credited (244x)
--   Cr the accounts receivable account the customer invoice's voucher
--      debited (151x)
--
-- for the set-off amount, at most the smaller of the two remaining amounts.
-- VAT is untouched: under faktureringsmetoden both invoices' VAT was booked
-- when they were registered. Both invoices get a dated payment row and their
-- remaining amounts go down, so the kund- and leverantörsreskontra show them
-- settled by the set-off, and the net is matched to the bank line by the
-- existing matching (partially_paid is matchable). Gross presentation stays
-- (ÅRL 2 kap 4 §, kvittningsförbud): this is a real settlement with a
-- voucher, never a netting of balances at period end.
--
-- Refused in this version (each with its own code): different parties, other
-- currencies than SEK, ROT/RUT invoices, credit notes and proformas, an
-- invoice without its booking voucher (kontantmetoden, deferred booking), an
-- open collection case, a supplier invoice in a payment file, payment order
-- or already entered at the bank, and a closed or locked period.
--
-- The way back is a storno of the set-off voucher (reverseEntry): the
-- reversal hook calls reverse_counterparty_setoff, which restores both
-- invoices exactly and removes the two payment rows. The voucher is never
-- corrected in place and the set-off row is never deleted.

-- =============================================================================
-- 1. journal_entries.source_type: 'counterparty_setoff'
-- =============================================================================
-- Rebuilt from 20261021120700_invoice_write_offs.sql (the latest definition);
-- the only change is the appended value. TS (JournalEntrySourceType) and Zod
-- (JournalEntrySourceTypeSchema) gain it in the same change.

ALTER TABLE public.journal_entries
  DROP CONSTRAINT IF EXISTS journal_entries_source_type_check;

ALTER TABLE public.journal_entries
  ADD CONSTRAINT journal_entries_source_type_check
  CHECK (source_type IN (
    'manual', 'bank_transaction', 'invoice_created',
    'invoice_paid', 'invoice_cash_payment', 'credit_note', 'salary_payment',
    'opening_balance', 'year_end',
    'storno', 'correction', 'import', 'system',
    'inbox_item',
    'supplier_invoice_registered', 'supplier_invoice_paid',
    'supplier_invoice_cash_payment', 'supplier_credit_note',
    'currency_revaluation',
    'supplier_invoice_privately_paid',
    'reminder_fee',
    'accrual',
    'result_appropriation',
    'rot_rut_payout',
    'vat_settlement',
    'stripe_payout',
    'webshop_order',
    'expense_claim',
    'expense_payout',
    'rot_rut_reclaim',
    'pos_daily_sales',
    'rot_rut_reclassification',
    'collection_settlement',
    'customer_loss',
    'counterparty_setoff'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- One live voucher per set-off. The service derives the set-off's id from the
-- two invoices and the number of earlier set-offs between them
-- (lib/invoices/counterparty-setoff/ids.ts), so two concurrent clicks compute
-- the same source_id and the loser fails at the draft insert, before a
-- voucher number is taken.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_counterparty_setoff_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'counterparty_setoff'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

-- =============================================================================
-- 2. invoice_payments.source: 'setoff'
-- =============================================================================
-- Rebuilt from 20261012030300_invoice_payment_provenance.sql (the only
-- definition); the only change is the appended value.

ALTER TABLE public.invoice_payments
  DROP CONSTRAINT IF EXISTS invoice_payments_source_check;

ALTER TABLE public.invoice_payments
  ADD CONSTRAINT invoice_payments_source_check
  CHECK (source IN ('manual', 'bank', 'stripe', 'collections', 'link', 'import', 'setoff')) NOT VALID;

ALTER TABLE public.invoice_payments
  VALIDATE CONSTRAINT invoice_payments_source_check;

COMMENT ON COLUMN public.invoice_payments.source IS
  'Where the payment came from: manual, bank, stripe, collections (collected by the collections provider), link (a voucher linked as the payment), import, or setoff (settled by kvittning against a supplier invoice of the same counterparty, counterparty_setoffs). NULL for rows written before 20261012030300.';

-- =============================================================================
-- 3. pending_operations.operation_type: 'book_counterparty_setoff'
-- =============================================================================
-- Expanded from the constraint's current definition, read from the catalog
-- (the pattern of 20261021120700), never re-stated from a copy, so no value
-- main added is dropped again. Keep it in step with the risk-tier table in
-- lib/pending-operations/risk-tiers.ts. NOT VALID; the VALIDATE runs in
-- 20261022130200.

DO $$
DECLARE
  v_types text[];
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  IF NOT ('book_counterparty_setoff' = ANY (v_types)) THEN
    v_types := v_types || 'book_counterparty_setoff'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

-- =============================================================================
-- 4. counterparty_setoffs: the record of every set-off
-- =============================================================================

CREATE TABLE public.counterparty_setoffs (
  -- Set by the service (lib/invoices/counterparty-setoff/ids.ts) and used as
  -- the voucher's source_id, so the row and its voucher name each other.
  id                          uuid PRIMARY KEY,
  company_id                  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Who booked the set-off.
  user_id                     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  -- The counterparty (canonical_party_id) both invoices belonged to when the
  -- set-off was booked. A snapshot: no foreign key, a later merge of parties
  -- does not rewrite history.
  party_id                    uuid NOT NULL,
  invoice_id                  uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  supplier_invoice_id         uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,
  amount                      numeric(14,2) NOT NULL CHECK (amount > 0),
  currency                    text NOT NULL DEFAULT 'SEK' CHECK (currency ~ '^[A-Z]{3}$'),
  setoff_date                 date NOT NULL,
  journal_entry_id            uuid NOT NULL REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  -- The two payment rows the set-off wrote. No foreign key: the storno
  -- removes the rows and the set-off keeps naming what it wrote.
  invoice_payment_id          uuid NOT NULL,
  supplier_invoice_payment_id uuid NOT NULL,
  -- The agreement or notice the set-off rests on, in a few words.
  note                        text CHECK (note IS NULL OR length(note) <= 500),
  status                      text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked', 'reversed')),
  reversed_at                 timestamptz,
  reversal_journal_entry_id   uuid REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT counterparty_setoffs_reversed_shape
    CHECK ((status = 'reversed') = (reversed_at IS NOT NULL AND reversal_journal_entry_id IS NOT NULL))
);

COMMENT ON TABLE public.counterparty_setoffs IS
  'Kvittning: a customer invoice settled against a supplier invoice of the same counterparty, with its voucher (source_type counterparty_setoff) and the two payment rows it wrote. Written only by book_counterparty_setoff, reversed only by reverse_counterparty_setoff after a storno of the voucher; never deleted (crm#1367).';

CREATE UNIQUE INDEX counterparty_setoffs_voucher_unique
  ON public.counterparty_setoffs (journal_entry_id);
CREATE INDEX counterparty_setoffs_company_party
  ON public.counterparty_setoffs (company_id, party_id, setoff_date);
CREATE INDEX counterparty_setoffs_invoice
  ON public.counterparty_setoffs (invoice_id);
CREATE INDEX counterparty_setoffs_supplier_invoice
  ON public.counterparty_setoffs (supplier_invoice_id);
CREATE INDEX counterparty_setoffs_user
  ON public.counterparty_setoffs (user_id);
CREATE INDEX counterparty_setoffs_reversal
  ON public.counterparty_setoffs (reversal_journal_entry_id) WHERE reversal_journal_entry_id IS NOT NULL;

ALTER TABLE public.counterparty_setoffs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "counterparty_setoffs_select" ON public.counterparty_setoffs
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- Read by members; written only by the two SECURITY DEFINER functions below.
GRANT SELECT ON TABLE public.counterparty_setoffs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.counterparty_setoffs TO service_role;
-- no-grant: anon on public.counterparty_setoffs (company data)

CREATE TRIGGER set_updated_at_counterparty_setoffs
  BEFORE UPDATE ON public.counterparty_setoffs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_counterparty_setoffs
  AFTER INSERT OR UPDATE OR DELETE ON public.counterparty_setoffs
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- Never deleted, and the one change a row takes is booked -> reversed. The
-- one exception is the sandbox teardown: inside cleanup_sandbox_user (flag
-- set, running as its owner) a row of a company that company_settings still
-- marks as a sandbox may go. delete_last_voucher cascading into a set-off
-- therefore aborts, and the storno stays the only way back.
CREATE OR REPLACE FUNCTION public.counterparty_setoffs_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)
     AND (SELECT pg_catalog.bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'SETOFF_DELETE_BLOCKED: a set-off is undone by a storno of its voucher, never deleted'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'booked' AND NEW.status = 'reversed'
     AND NEW.id = OLD.id
     AND NEW.company_id = OLD.company_id
     AND NEW.user_id = OLD.user_id
     AND NEW.party_id = OLD.party_id
     AND NEW.invoice_id = OLD.invoice_id
     AND NEW.supplier_invoice_id = OLD.supplier_invoice_id
     AND NEW.amount = OLD.amount
     AND NEW.currency = OLD.currency
     AND NEW.setoff_date = OLD.setoff_date
     AND NEW.journal_entry_id = OLD.journal_entry_id
     AND NEW.invoice_payment_id = OLD.invoice_payment_id
     AND NEW.supplier_invoice_payment_id = OLD.supplier_invoice_payment_id
     AND NEW.note IS NOT DISTINCT FROM OLD.note
     AND NEW.created_at = OLD.created_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'SETOFF_IMMUTABLE: a set-off changes only from booked to reversed, by a storno of its voucher'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER counterparty_setoffs_guard
  BEFORE UPDATE OR DELETE ON public.counterparty_setoffs
  FOR EACH ROW EXECUTE FUNCTION public.counterparty_setoffs_guard();

-- =============================================================================
-- 5. A set-off voucher is not corrected in place
-- =============================================================================
-- Its amount and date are the set-off's: an inline rättelse of its lines
-- (correct_entry_lines_inline sets gnubok.allow_line_rattelse) or a new date
-- (correct_entry_metadata) would leave the set-off row, both invoices and
-- their payment rows describing another voucher. The way back is a storno of
-- the whole voucher. The TypeScript correction paths refuse the same
-- (SetoffVoucherLockedError in lib/core/bookkeeping/storno-service.ts).
CREATE OR REPLACE FUNCTION public.guard_counterparty_setoff_voucher_lines()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)
      AND je.source_type = 'counterparty_setoff'
  ) THEN
    RAISE EXCEPTION 'SETOFF_VOUCHER_LOCKED: a set-off voucher is not corrected in place; reverse it instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Fires only inside an inline rättelse, so ordinary posting pays nothing.
CREATE TRIGGER guard_counterparty_setoff_voucher_lines
  BEFORE INSERT OR UPDATE ON public.journal_entry_lines
  FOR EACH ROW
  WHEN (current_setting('gnubok.allow_line_rattelse', true) = 'true')
  EXECUTE FUNCTION public.guard_counterparty_setoff_voucher_lines();

CREATE OR REPLACE FUNCTION public.guard_counterparty_setoff_voucher_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  RAISE EXCEPTION 'SETOFF_VOUCHER_LOCKED: a set-off voucher keeps its date; reverse it instead'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER guard_counterparty_setoff_voucher_date
  BEFORE UPDATE OF entry_date ON public.journal_entries
  FOR EACH ROW
  WHEN (OLD.source_type = 'counterparty_setoff' AND OLD.status = 'posted'
        AND NEW.entry_date IS DISTINCT FROM OLD.entry_date)
  EXECUTE FUNCTION public.guard_counterparty_setoff_voucher_date();

-- =============================================================================
-- 6. book_counterparty_setoff: the one writer
-- =============================================================================
-- Called through its engine door (commitCounterpartySetoff,
-- lib/bookkeeping/engine.ts, via the posting port's commitSqlPosting). Every
-- refusal is checked under the two invoices' row locks before anything is
-- written, so a refusal never takes a voucher number; then the draft, the
-- posting port's event link, the two lines, commit_journal_entry, both
-- invoice updates, both payment rows and the set-off row, in one transaction.
--
-- Actor: p_user_id is honoured only for a service_role caller (the v1 and
-- MCP doors run on the cookieless service client); any other caller is
-- pinned to its own auth.uid(), and must be a member of the company who is
-- not a viewer (the pattern of match_batch_allocate).
--
-- The accounts are the invoices' own: the 151x account (not 1513 or 1519)
-- the customer invoice's voucher debited and the 244x account the supplier
-- invoice's registration voucher credited, each the largest such line. The
-- invoice must carry that posted voucher; an invoice that never reached the
-- ledger as a fordran or skuld (kontantmetoden, deferred booking) is refused.
--
-- Answers {ok: false, code, details} for a refusal, {ok: true, ...} once
-- booked. A second booking with the same p_setoff_id fails with 23505 at the
-- draft insert (journal_entries_counterparty_setoff_live_unique).

CREATE OR REPLACE FUNCTION public.book_counterparty_setoff(
  p_company_id uuid,
  p_setoff_id uuid,
  p_invoice_id uuid,
  p_supplier_invoice_id uuid,
  p_amount numeric,
  p_setoff_date date,
  p_note text DEFAULT NULL,
  p_user_id uuid DEFAULT NULL,
  p_actor_type text DEFAULT NULL,
  p_actor_label text DEFAULT NULL,
  p_event_ids uuid[] DEFAULT NULL,
  p_event_mode text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_inv RECORD;
  v_si RECORD;
  v_inv_party uuid;
  v_si_party uuid;
  v_inv_remaining numeric;
  v_si_remaining numeric;
  v_receivable text;
  v_payable text;
  v_fiscal_period_id uuid;
  v_period_is_closed boolean;
  v_period_locked_at timestamptz;
  v_lock_date date;
  v_series_raw text;
  v_series text := 'A';
  v_entry_id uuid := gen_random_uuid();
  v_voucher_number int;
  v_inv_number text;
  v_si_number text;
  v_counterparty text;
  v_description text;
  v_inv_dims jsonb;
  v_si_dims jsonb;
  v_inv_new_paid numeric;
  v_inv_new_remaining numeric;
  v_inv_new_status text;
  v_si_new_paid numeric;
  v_si_new_remaining numeric;
  v_si_new_status text;
  v_inv_payment_id uuid;
  v_si_payment_id uuid;
  v_paid_at timestamptz;
  v_now timestamptz := now();
  v_today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
  v_note text := NULLIF(btrim(COALESCE(p_note, '')), '');
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role <> 'viewer'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_FORBIDDEN');
  END IF;

  IF p_setoff_id IS NULL OR p_invoice_id IS NULL OR p_supplier_invoice_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVALID_REQUEST');
  END IF;
  IF p_amount IS NULL OR p_amount <= 0 OR p_amount <> round(p_amount, 2) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVALID_AMOUNT',
      'details', jsonb_build_object('amount', p_amount));
  END IF;
  IF v_note IS NOT NULL AND length(v_note) > 500 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVALID_REQUEST',
      'details', jsonb_build_object('field', 'note'));
  END IF;

  -- The invoice first, then the supplier invoice: every caller locks in this order.
  SELECT * INTO v_inv FROM public.invoices
    WHERE id = p_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_FOUND',
      'details', jsonb_build_object('invoice_id', p_invoice_id));
  END IF;
  SELECT * INTO v_si FROM public.supplier_invoices
    WHERE id = p_supplier_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_SUPPLIER_INVOICE_NOT_FOUND',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id));
  END IF;

  IF COALESCE(v_inv.document_type, 'invoice') <> 'invoice' OR v_inv.credited_invoice_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_ELIGIBLE',
      'details', jsonb_build_object('invoice_id', p_invoice_id, 'document_type', v_inv.document_type));
  END IF;
  IF COALESCE(v_si.is_credit_note, false) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_SUPPLIER_INVOICE_NOT_ELIGIBLE',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id));
  END IF;
  IF v_inv.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_OPEN',
      'details', jsonb_build_object('invoice_id', p_invoice_id, 'status', v_inv.status));
  END IF;
  IF v_si.status NOT IN ('registered', 'approved', 'overdue', 'partially_paid') THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_SUPPLIER_INVOICE_NOT_OPEN',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id, 'status', v_si.status));
  END IF;
  IF COALESCE(v_inv.currency, 'SEK') <> 'SEK' OR COALESCE(v_si.currency, 'SEK') <> 'SEK' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_CURRENCY_UNSUPPORTED',
      'details', jsonb_build_object('invoice_currency', v_inv.currency, 'supplier_invoice_currency', v_si.currency));
  END IF;
  IF COALESCE(v_inv.deduction_total, 0) > 0 THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_DEDUCTION_UNSUPPORTED',
      'details', jsonb_build_object('invoice_id', p_invoice_id));
  END IF;
  IF v_inv.journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_BOOKED',
      'details', jsonb_build_object('side', 'customer', 'invoice_id', p_invoice_id));
  END IF;
  IF v_si.registration_journal_entry_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_INVOICE_NOT_BOOKED',
      'details', jsonb_build_object('side', 'supplier', 'supplier_invoice_id', p_supplier_invoice_id));
  END IF;

  SELECT public.canonical_party_id(c.party_id) INTO v_inv_party
    FROM public.customers c WHERE c.id = v_inv.customer_id AND c.company_id = p_company_id;
  SELECT public.canonical_party_id(s.party_id) INTO v_si_party
    FROM public.suppliers s WHERE s.id = v_si.supplier_id AND s.company_id = p_company_id;
  IF v_inv_party IS NULL OR v_si_party IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_NO_PARTY',
      'details', jsonb_build_object('customer_party', v_inv_party IS NOT NULL, 'supplier_party', v_si_party IS NOT NULL));
  END IF;
  IF v_inv_party <> v_si_party THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_PARTY_MISMATCH');
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.collection_cases cc
    WHERE cc.company_id = p_company_id AND cc.invoice_id = p_invoice_id AND cc.is_open
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_COLLECTION_OPEN',
      'details', jsonb_build_object('invoice_id', p_invoice_id));
  END IF;

  -- A payment the bank may still carry out for the full amount: entered at
  -- the bank, in a payment file not cancelled, or in an open payment order
  -- (isOpenPaymentOrder, lib/payments/orders/status.ts).
  IF v_si.bank_entered_at IS NOT NULL
     OR EXISTS (
       SELECT 1
         FROM public.supplier_payment_batch_items bi
         JOIN public.supplier_payment_batches b ON b.id = bi.batch_id AND b.company_id = bi.company_id
        WHERE bi.company_id = p_company_id
          AND bi.supplier_invoice_id = p_supplier_invoice_id
          AND b.status = 'created'
     )
     OR EXISTS (
       SELECT 1 FROM public.payment_orders po
        WHERE po.company_id = p_company_id
          AND po.supplier_invoice_id = p_supplier_invoice_id
          AND (po.status IN ('draft', 'approved', 'submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted')
               OR (po.status = 'executed' AND po.supplier_invoice_payment_id IS NULL))
     ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_PAYMENT_IN_FLIGHT',
      'details', jsonb_build_object('supplier_invoice_id', p_supplier_invoice_id));
  END IF;

  v_inv_remaining := round(COALESCE(v_inv.remaining_amount, v_inv.total), 2);
  v_si_remaining := round(COALESCE(v_si.remaining_amount, v_si.total), 2);
  IF p_amount > v_inv_remaining OR p_amount > v_si_remaining THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_AMOUNT_EXCEEDS_REMAINING',
      'details', jsonb_build_object('amount', p_amount,
        'invoice_remaining', v_inv_remaining, 'supplier_invoice_remaining', v_si_remaining));
  END IF;

  IF p_setoff_date IS NULL OR p_setoff_date > v_today THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_DATE_INVALID',
      'details', jsonb_build_object('reason', 'future', 'setoff_date', p_setoff_date));
  END IF;
  IF p_setoff_date < v_inv.invoice_date OR p_setoff_date < v_si.invoice_date THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_DATE_INVALID',
      'details', jsonb_build_object('reason', 'before_invoice', 'setoff_date', p_setoff_date));
  END IF;

  SELECT fp.id, fp.is_closed, fp.locked_at INTO v_fiscal_period_id, v_period_is_closed, v_period_locked_at
    FROM public.fiscal_periods fp
   WHERE fp.company_id = p_company_id AND p_setoff_date BETWEEN fp.period_start AND fp.period_end
   ORDER BY fp.period_start DESC LIMIT 1;
  IF v_fiscal_period_id IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_NO_FISCAL_PERIOD',
      'details', jsonb_build_object('setoff_date', p_setoff_date));
  END IF;
  SELECT cs.bookkeeping_locked_through INTO v_lock_date
    FROM public.company_settings cs WHERE cs.company_id = p_company_id;
  IF v_period_is_closed OR v_period_locked_at IS NOT NULL
     OR (v_lock_date IS NOT NULL AND p_setoff_date <= v_lock_date) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_PERIOD_LOCKED',
      'details', jsonb_build_object('setoff_date', p_setoff_date, 'fiscal_period_id', v_fiscal_period_id,
        'locked_through', v_lock_date));
  END IF;

  SELECT l.account_number INTO v_receivable
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE je.id = v_inv.journal_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'posted'
     AND l.account_number ~ '^151[0-9]$'
     AND l.account_number NOT IN ('1513', '1519')
     AND l.debit_amount > 0
   ORDER BY l.debit_amount DESC, l.account_number
   LIMIT 1;
  IF v_receivable IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_LEDGER_MISMATCH',
      'details', jsonb_build_object('side', 'customer', 'journal_entry_id', v_inv.journal_entry_id));
  END IF;
  SELECT l.account_number INTO v_payable
    FROM public.journal_entry_lines l
    JOIN public.journal_entries je ON je.id = l.journal_entry_id
   WHERE je.id = v_si.registration_journal_entry_id
     AND je.company_id = p_company_id
     AND je.status = 'posted'
     AND l.account_number ~ '^244[0-9]$'
     AND l.credit_amount > 0
   ORDER BY l.credit_amount DESC, l.account_number
   LIMIT 1;
  IF v_payable IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_LEDGER_MISMATCH',
      'details', jsonb_build_object('side', 'supplier', 'journal_entry_id', v_si.registration_journal_entry_id));
  END IF;

  -- Voucher series: the company's default for counterparty_setoff, 'A' when
  -- there is no settings row, no key or no single A-Z letter (the rule of
  -- resolveDefaultSeriesForSource, lib/bookkeeping/voucher-series-resolver.ts).
  SELECT cs.default_voucher_series_per_source_type ->> 'counterparty_setoff'
    INTO v_series_raw
    FROM public.company_settings cs
   WHERE cs.company_id = p_company_id;
  IF v_series_raw ~ '^[A-Z]$' THEN
    v_series := v_series_raw;
  END IF;

  -- The numbers shown everywhere: a self-billed sale has no own number, so its
  -- external_invoice_number (invoiceDisplayNumber, lib/invoices/display.ts);
  -- a supplier invoice without a printed number is named by its löpnummer.
  v_inv_number := COALESCE(NULLIF(v_inv.invoice_number, ''), NULLIF(v_inv.external_invoice_number, ''), '');
  v_si_number := COALESCE(NULLIF(v_si.supplier_invoice_number, ''), 'ankomstnr ' || v_si.arrival_number::text);
  SELECT c.name INTO v_counterparty FROM public.customers c WHERE c.id = v_inv.customer_id;
  v_description := left(
    'Kvittning kundfaktura ' || v_inv_number || ' mot leverantörsfaktura ' || v_si_number
      || COALESCE(', ' || NULLIF(v_counterparty, ''), ''),
    500);
  v_inv_dims := public.coerce_dimensions_bag(v_inv.default_dimensions);
  v_si_dims := public.coerce_dimensions_bag(v_si.default_dimensions);

  INSERT INTO public.journal_entries
    (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
     entry_date, description, source_type, source_id, status)
  VALUES
    (v_entry_id, v_caller, p_company_id, v_fiscal_period_id, 0, v_series,
     p_setoff_date, v_description, 'counterparty_setoff', p_setoff_id, 'draft');

  -- The posting port's counterparty.set_off event, linked to the draft
  -- before commit_journal_entry draws its number (20261018210000).
  PERFORM public.link_business_events_to_draft(
    p_company_id, v_entry_id, p_event_ids, 'produced', p_event_mode);

  INSERT INTO public.journal_entry_lines
    (journal_entry_id, account_number, debit_amount, credit_amount, currency,
     sort_order, line_description, dimensions)
  VALUES
    (v_entry_id, v_payable, p_amount, 0, 'SEK', 0,
     left('Leverantörsfaktura ' || v_si_number, 200), v_si_dims),
    (v_entry_id, v_receivable, 0, p_amount, 'SEK', 1,
     left('Kundfaktura ' || v_inv_number, 200), v_inv_dims);

  -- WHO: the actor the application door passes (commitCounterpartySetoff),
  -- stamped by commit_journal_entry like any other commit.
  SELECT voucher_number INTO v_voucher_number
    FROM public.commit_journal_entry(p_company_id, v_entry_id, NULL, NULL, p_actor_type, p_actor_label);

  v_paid_at := (p_setoff_date::timestamp + interval '12 hours') AT TIME ZONE 'UTC';

  v_inv_new_paid := round(COALESCE(v_inv.paid_amount, 0) + p_amount, 2);
  v_inv_new_remaining := GREATEST(0, round(v_inv_remaining - p_amount, 2));
  v_inv_new_status := CASE WHEN v_inv_new_remaining <= 0 THEN 'paid' ELSE 'partially_paid' END;
  UPDATE public.invoices SET
      status = v_inv_new_status,
      paid_at = CASE WHEN v_inv_new_status = 'paid' THEN v_paid_at ELSE paid_at END,
      paid_amount = v_inv_new_paid,
      remaining_amount = v_inv_new_remaining,
      updated_at = v_now
    WHERE id = p_invoice_id AND company_id = p_company_id;

  INSERT INTO public.invoice_payments
    (user_id, company_id, invoice_id, payment_date, amount, currency, exchange_rate,
     journal_entry_id, transaction_id, source, notes, link_basis, link_evidence)
  VALUES
    (v_caller, p_company_id, p_invoice_id, p_setoff_date, p_amount, 'SEK', v_inv.exchange_rate,
     v_entry_id, NULL, 'setoff', left('Kvittning mot leverantörsfaktura ' || v_si_number, 500),
     public.resolve_link_basis('user_created', p_actor_type), NULL)
  RETURNING id INTO v_inv_payment_id;

  v_si_new_paid := round(COALESCE(v_si.paid_amount, 0) + p_amount, 2);
  v_si_new_remaining := GREATEST(0, round(v_si_remaining - p_amount, 2));
  v_si_new_status := CASE WHEN v_si_new_remaining <= 0 THEN 'paid' ELSE 'partially_paid' END;
  UPDATE public.supplier_invoices SET
      status = v_si_new_status,
      paid_at = CASE WHEN v_si_new_status = 'paid' THEN v_paid_at ELSE paid_at END,
      paid_amount = v_si_new_paid,
      remaining_amount = v_si_new_remaining,
      payment_journal_entry_id = v_entry_id,
      updated_at = v_now
    WHERE id = p_supplier_invoice_id AND company_id = p_company_id;

  INSERT INTO public.supplier_invoice_payments
    (user_id, company_id, supplier_invoice_id, payment_date, amount, currency, exchange_rate,
     journal_entry_id, transaction_id, notes, link_basis, link_evidence)
  VALUES
    (v_caller, p_company_id, p_supplier_invoice_id, p_setoff_date, p_amount, 'SEK', v_si.exchange_rate,
     v_entry_id, NULL, left('Kvittning mot kundfaktura ' || v_inv_number, 500),
     public.resolve_link_basis('user_created', p_actor_type), NULL)
  RETURNING id INTO v_si_payment_id;

  INSERT INTO public.counterparty_setoffs
    (id, company_id, user_id, party_id, invoice_id, supplier_invoice_id, amount, currency,
     setoff_date, journal_entry_id, invoice_payment_id, supplier_invoice_payment_id, note)
  VALUES
    (p_setoff_id, p_company_id, v_caller, v_inv_party, p_invoice_id, p_supplier_invoice_id, p_amount, 'SEK',
     p_setoff_date, v_entry_id, v_inv_payment_id, v_si_payment_id, v_note);

  RETURN jsonb_build_object(
    'ok', true,
    'setoff_id', p_setoff_id,
    'journal_entry_id', v_entry_id,
    'voucher_series', v_series,
    'voucher_number', v_voucher_number,
    'party_id', v_inv_party,
    'amount', p_amount,
    'receivable_account', v_receivable,
    'payable_account', v_payable,
    'invoice', jsonb_build_object(
      'invoice_id', p_invoice_id, 'payment_id', v_inv_payment_id, 'status', v_inv_new_status,
      'paid_amount', v_inv_new_paid, 'remaining_amount', v_inv_new_remaining),
    'supplier_invoice', jsonb_build_object(
      'supplier_invoice_id', p_supplier_invoice_id, 'payment_id', v_si_payment_id, 'status', v_si_new_status,
      'paid_amount', v_si_new_paid, 'remaining_amount', v_si_new_remaining)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.book_counterparty_setoff(
  uuid, uuid, uuid, uuid, numeric, date, text, uuid, text, text, uuid[], text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.book_counterparty_setoff(
  uuid, uuid, uuid, uuid, numeric, date, text, uuid, text, text, uuid[], text
) TO authenticated, service_role;

COMMENT ON FUNCTION public.book_counterparty_setoff(
  uuid, uuid, uuid, uuid, numeric, date, text, uuid, text, text, uuid[], text
) IS
  'Kvittning: books Dr 244x / Cr 151x for p_amount between a customer invoice and a supplier invoice of the same party (canonical_party_id), lowers both remaining amounts, writes a payment row on each side and the counterparty_setoffs row, in one transaction. Every refusal is answered as {ok: false, code} before anything is written. p_user_id is honoured only for service_role callers. p_event_ids (the posting port''s counterparty.set_off event) are linked to the draft before its number is drawn (crm#1367).';

-- =============================================================================
-- 7. reverse_counterparty_setoff: the set-off side of a storno
-- =============================================================================
-- Called by the reversal hook (lib/invoices/counterparty-setoff/reversal.ts)
-- after reverseEntry() has posted the storno of a set-off voucher: restores
-- both invoices exactly (the set-off amount back onto their remaining
-- amounts), removes the two payment rows and marks the set-off reversed. The
-- storno must exist and reverse this set-off's voucher, so the set-off cannot
-- be undone without its voucher being reversed.

CREATE OR REPLACE FUNCTION public.reverse_counterparty_setoff(
  p_company_id uuid,
  p_setoff_id uuid,
  p_storno_entry_id uuid,
  p_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_caller uuid;
  v_row public.counterparty_setoffs%ROWTYPE;
  v_storno RECORD;
  v_inv RECORD;
  v_si RECORD;
  v_inv_new_paid numeric;
  v_inv_new_remaining numeric;
  v_inv_new_status text;
  v_si_new_paid numeric;
  v_si_new_remaining numeric;
  v_si_new_status text;
  v_today date := (now() AT TIME ZONE 'Europe/Stockholm')::date;
BEGIN
  IF auth.role() = 'service_role' THEN
    v_caller := COALESCE(p_user_id, auth.uid());
  ELSE
    v_caller := auth.uid();
  END IF;
  IF v_caller IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members m
    WHERE m.company_id = p_company_id AND m.user_id = v_caller AND m.role <> 'viewer'
  ) THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_FORBIDDEN');
  END IF;

  SELECT * INTO v_row FROM public.counterparty_setoffs
    WHERE id = p_setoff_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_NOT_FOUND');
  END IF;
  IF v_row.status <> 'booked' THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_ALREADY_REVERSED');
  END IF;

  SELECT je.id, je.source_type, je.status, je.reverses_id INTO v_storno
    FROM public.journal_entries je
   WHERE je.id = p_storno_entry_id AND je.company_id = p_company_id;
  IF NOT FOUND OR v_storno.source_type <> 'storno' OR v_storno.status <> 'posted'
     OR v_storno.reverses_id IS DISTINCT FROM v_row.journal_entry_id THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_STORNO_MISMATCH');
  END IF;

  -- Same lock order as book_counterparty_setoff: the invoice first.
  SELECT * INTO v_inv FROM public.invoices
    WHERE id = v_row.invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_REVERSAL_BLOCKED',
      'details', jsonb_build_object('reason', 'invoice_missing'));
  END IF;
  SELECT * INTO v_si FROM public.supplier_invoices
    WHERE id = v_row.supplier_invoice_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_REVERSAL_BLOCKED',
      'details', jsonb_build_object('reason', 'supplier_invoice_missing'));
  END IF;
  IF v_inv.status IN ('written_off', 'credited', 'cancelled', 'draft')
     OR v_si.status IN ('credited', 'reversed')
     OR COALESCE(v_inv.paid_amount, 0) < v_row.amount
     OR COALESCE(v_si.paid_amount, 0) < v_row.amount THEN
    RETURN jsonb_build_object('ok', false, 'code', 'SETOFF_REVERSAL_BLOCKED',
      'details', jsonb_build_object('invoice_status', v_inv.status, 'supplier_invoice_status', v_si.status));
  END IF;

  v_inv_new_paid := round(COALESCE(v_inv.paid_amount, 0) - v_row.amount, 2);
  v_inv_new_remaining := round(COALESCE(v_inv.remaining_amount, 0) + v_row.amount, 2);
  v_inv_new_status := CASE
    WHEN v_inv_new_paid > 0 THEN 'partially_paid'
    WHEN v_inv.due_date IS NOT NULL AND v_inv.due_date < v_today THEN 'overdue'
    ELSE 'sent'
  END;
  UPDATE public.invoices SET
      status = v_inv_new_status,
      paid_at = NULL,
      paid_amount = v_inv_new_paid,
      remaining_amount = v_inv_new_remaining,
      updated_at = now()
    WHERE id = v_row.invoice_id AND company_id = p_company_id;

  v_si_new_paid := round(COALESCE(v_si.paid_amount, 0) - v_row.amount, 2);
  v_si_new_remaining := round(COALESCE(v_si.remaining_amount, 0) + v_row.amount, 2);
  v_si_new_status := CASE
    WHEN v_si_new_paid > 0 THEN 'partially_paid'
    WHEN v_si.due_date IS NOT NULL AND v_si.due_date < v_today THEN 'overdue'
    WHEN v_si.approved_at IS NOT NULL THEN 'approved'
    ELSE 'registered'
  END;
  UPDATE public.supplier_invoices SET
      status = v_si_new_status,
      paid_at = NULL,
      paid_amount = v_si_new_paid,
      remaining_amount = v_si_new_remaining,
      payment_journal_entry_id = CASE
        WHEN payment_journal_entry_id = v_row.journal_entry_id THEN NULL
        ELSE payment_journal_entry_id
      END,
      updated_at = now()
    WHERE id = v_row.supplier_invoice_id AND company_id = p_company_id;

  DELETE FROM public.invoice_payments
   WHERE id = v_row.invoice_payment_id AND company_id = p_company_id;
  DELETE FROM public.supplier_invoice_payments
   WHERE id = v_row.supplier_invoice_payment_id AND company_id = p_company_id;

  UPDATE public.counterparty_setoffs SET
      status = 'reversed',
      reversed_at = now(),
      reversal_journal_entry_id = p_storno_entry_id
    WHERE id = p_setoff_id AND company_id = p_company_id;

  RETURN jsonb_build_object(
    'ok', true,
    'setoff_id', p_setoff_id,
    'invoice', jsonb_build_object('invoice_id', v_row.invoice_id, 'status', v_inv_new_status,
      'paid_amount', v_inv_new_paid, 'remaining_amount', v_inv_new_remaining),
    'supplier_invoice', jsonb_build_object('supplier_invoice_id', v_row.supplier_invoice_id,
      'status', v_si_new_status, 'paid_amount', v_si_new_paid, 'remaining_amount', v_si_new_remaining)
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.reverse_counterparty_setoff(uuid, uuid, uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.reverse_counterparty_setoff(uuid, uuid, uuid, uuid) TO authenticated, service_role;

COMMENT ON FUNCTION public.reverse_counterparty_setoff(uuid, uuid, uuid, uuid) IS
  'The set-off side of a storno of a counterparty_setoff voucher: gives both invoices the set-off amount back, removes the two payment rows and marks the set-off reversed. Refused unless p_storno_entry_id is the posted storno of the set-off''s voucher. p_user_id is honoured only for service_role callers (crm#1367).';

NOTIFY pgrst, 'reload schema';
