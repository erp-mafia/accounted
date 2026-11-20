-- Kundförlust: befarad (a valuation reserve), konstaterad (the claim is
-- written off) and återvunnen (a payment after the write-off), with an honest
-- invoice status for a written-off claim.
-- pg-test: tests/pg/invoice-write-offs.pg.test.ts,
--          tests/pg/collection-settlements.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts,
--          tests/pg/pending-operations-op-type-audit.pg.test.ts
--
-- Postings (lib/customer-loss, every voucher through the bookkeeping engine,
-- source_type customer_loss):
--   befarad      Dr 6352 / Cr 1519, net of VAT. The claim still stands and
--                collection goes on, so the invoice keeps its status.
--   reserve out  Dr 1519 / Cr 6352 when a payment or a credit makes part of
--                the reserve unnecessary (reversed_doubtful).
--   konstaterad  Dr 6351 (net) + Dr 26xx (the open output VAT, per account)
--                / Cr 1510 at the open amount, plus Dr 1519 / Cr 6352 for any
--                reserve still held. ML 8 kap 16 § and 7 kap 43-44 §§. The
--                invoice becomes 'written_off'. Under kontantmetoden an
--                invoice that never reached the ledger as a fordran gets no
--                voucher: the row records the decision and the status.
--   återvunnen   Dr bank / Cr 3950 (net) + Cr 26xx (the VAT reported again).
--                The status stays 'written_off': a recovery is income, never
--                a silent reopening.
--   annulled     the storno of one of the vouchers above (the generic
--                reverse path, lib/bookkeeping/engine.ts reverseEntry); a
--                konstaterad annulment gives the invoice its open status back.
--
-- A payment the collections provider collected on a written-off invoice is
-- booked as återvunnen against the clearing account (section 8).
--
-- The momsdeklaration reads the per-rate bases recorded here
-- (vat_by_rate[].base) to move ruta 05 with ruta 10 to 12: a konstaterad row
-- lowers it, a recovery raises it again (lib/reports/vat-declaration.ts).

-- =============================================================================
-- 1. invoices.status: 'written_off'
-- =============================================================================
-- Rebuilt from 20260323120001_invoice_partial_payments.sql (the latest
-- definition); the only change is the appended value.

ALTER TABLE public.invoices
  DROP CONSTRAINT IF EXISTS invoices_status_check;

ALTER TABLE public.invoices
  ADD CONSTRAINT invoices_status_check
  CHECK (status IN ('draft', 'sent', 'paid', 'partially_paid', 'overdue', 'cancelled', 'credited',
                    'written_off')) NOT VALID;

ALTER TABLE public.invoices
  VALIDATE CONSTRAINT invoices_status_check;

-- =============================================================================
-- 2. journal_entries.source_type: 'customer_loss'
-- =============================================================================
-- Rebuilt from 20261021120000_collection_settlements.sql (the latest
-- definition: main's 32 values from 20261015001000_migrated_invoice_deduction
-- .sql, rot_rut_reclassification included, plus collection_settlement); the
-- only change is the appended value. TS (JournalEntrySourceType) and Zod
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
    'customer_loss'
  )) NOT VALID;

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_source_type_check;

-- One live voucher per write-off decision. The service derives the decision's
-- id from the invoice, the kind and the number of earlier rows of that kind
-- (lib/customer-loss/ids.ts), so two concurrent clicks on the same invoice
-- compute the same source_id and the loser fails at the draft insert, before
-- a voucher number is taken. draft included for that reason.
CREATE UNIQUE INDEX IF NOT EXISTS journal_entries_customer_loss_live_unique
  ON public.journal_entries (company_id, source_id)
  WHERE source_type = 'customer_loss'
    AND source_id IS NOT NULL
    AND status IN ('draft', 'posted');

-- =============================================================================
-- 3. pending_operations.operation_type: 'record_customer_loss'
-- =============================================================================
-- Expanded from the constraint's current definition, read from the catalog
-- (the pattern of 20261015170000 and 20261021120400: main's latest values plus
-- the two collections bookings), never re-stated from a copy, so no value
-- main added is dropped again. Keep it in step with the risk-tier table in
-- lib/pending-operations/risk-tiers.ts, which PendingOperationType derives
-- from. NOT VALID; the VALIDATE runs in 20261021120800.

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
  IF NOT ('record_customer_loss' = ANY (v_types)) THEN
    v_types := v_types || 'record_customer_loss'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

-- =============================================================================
-- 4. invoice_write_offs: the append-only record of every kundförlust decision
-- =============================================================================

CREATE TABLE public.invoice_write_offs (
  -- Set by the service (lib/customer-loss/ids.ts) and used as the voucher's
  -- source_id, so the row and its voucher name each other.
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  kind text NOT NULL
    CHECK (kind IN ('doubtful', 'reversed_doubtful', 'confirmed', 'recovered', 'annulled')),
  -- The voucher's date (for an annulment: the storno's date). The
  -- momsdeklaration places the row in its period by this date.
  entry_date date NOT NULL,
  -- The part of the claim, VAT included, the decision concerns.
  amount numeric(14,2) NOT NULL CHECK (amount >= 0),
  -- On 6352 (doubtful, reversed_doubtful), 6351 (confirmed) or 3950
  -- (recovered): the amount excluding VAT.
  net_amount numeric(14,2) NOT NULL CHECK (net_amount >= 0),
  -- The VAT share of `amount`: booked on 26xx for confirmed and recovered,
  -- informational for doubtful (a reserve never touches VAT).
  vat_amount numeric(14,2) NOT NULL DEFAULT 0 CHECK (vat_amount >= 0),
  -- [{"account": "2611", "rate": 25, "vat": 200.00, "base": 800.00}, ...]
  vat_by_rate jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(vat_by_rate) = 'array'),
  -- A konstaterad decision on an invoice that held a reserve releases it in
  -- the same voucher (Dr 1519 / Cr 6352).
  reserve_released numeric(14,2) NOT NULL DEFAULT 0 CHECK (reserve_released >= 0),
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE RESTRICT,
  -- Konstaterad: the document that shows the customer cannot pay
  -- (konkursbesked, beslut från Kronofogden, ...). BFL 5 kap 6 §.
  evidence_document_id uuid REFERENCES public.document_attachments(id) ON DELETE RESTRICT,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  case_id uuid REFERENCES public.collection_cases(id) ON DELETE RESTRICT,
  -- Annulled: the row whose voucher the storno reversed.
  reverses_id uuid REFERENCES public.invoice_write_offs(id) ON DELETE NO ACTION,
  decided_by uuid REFERENCES auth.users(id),
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invoice_write_offs_amount_split CHECK (amount = net_amount + vat_amount),
  CONSTRAINT invoice_write_offs_annulled_shape
    CHECK ((kind = 'annulled') = (reverses_id IS NOT NULL)),
  -- Only a konstaterad decision on a never-booked invoice has no voucher.
  CONSTRAINT invoice_write_offs_voucher
    CHECK (kind = 'confirmed' OR journal_entry_id IS NOT NULL),
  CONSTRAINT invoice_write_offs_evidence
    CHECK (kind <> 'confirmed' OR evidence_document_id IS NOT NULL)
);

COMMENT ON TABLE public.invoice_write_offs IS
  'Append-only record of kundförlust decisions on customer invoices: befarad reserve, its release, konstaterad write-off, recovery and annulment (storno). Written only through record_invoice_write_off().';

CREATE UNIQUE INDEX invoice_write_offs_voucher_unique
  ON public.invoice_write_offs (journal_entry_id) WHERE journal_entry_id IS NOT NULL;
-- One annulment per decision.
CREATE UNIQUE INDEX invoice_write_offs_reverses_unique
  ON public.invoice_write_offs (reverses_id) WHERE reverses_id IS NOT NULL;
CREATE INDEX invoice_write_offs_invoice ON public.invoice_write_offs (invoice_id, decided_at);
CREATE INDEX invoice_write_offs_company_date ON public.invoice_write_offs (company_id, entry_date);
CREATE INDEX invoice_write_offs_evidence ON public.invoice_write_offs (evidence_document_id)
  WHERE evidence_document_id IS NOT NULL;
CREATE INDEX invoice_write_offs_case ON public.invoice_write_offs (case_id) WHERE case_id IS NOT NULL;

ALTER TABLE public.invoice_write_offs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "invoice_write_offs_select" ON public.invoice_write_offs
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.invoice_write_offs TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.invoice_write_offs TO service_role;
-- no-grant: anon on public.invoice_write_offs (company data)

-- Append-only. The one exception is the sandbox teardown: inside
-- cleanup_sandbox_user (flag set, running as its owner) a row of a company
-- that company_settings still marks as a sandbox may go. UPDATE never.
CREATE OR REPLACE FUNCTION public.invoice_write_offs_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND current_user = (SELECT pg_catalog.pg_get_userbyid(p.proowner) FROM pg_catalog.pg_proc p
          WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::pg_catalog.regprocedure)
     AND (SELECT pg_catalog.bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'invoice_write_offs is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER invoice_write_offs_immutable
  BEFORE UPDATE OR DELETE ON public.invoice_write_offs
  FOR EACH ROW EXECUTE FUNCTION public.invoice_write_offs_immutable();

-- =============================================================================
-- 5. 'written_off' is entered and left only through record_invoice_write_off
-- =============================================================================
-- A written-off claim is no longer on 1510, so no payment, credit, overdue
-- sweep or import may move the invoice out of the status (a payment after
-- the write-off is a recovery, booked on 3950), and nothing but a recorded
-- konstaterad decision may move it in.

CREATE OR REPLACE FUNCTION public.guard_invoice_written_off_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF current_setting('gnubok.customer_loss_status', true) = 'true' THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'written_off' THEN
      RAISE EXCEPTION 'INVOICE_WRITTEN_OFF_STATUS_LOCKED: an invoice is written off only by a recorded customer loss'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND (OLD.status = 'written_off' OR NEW.status = 'written_off') THEN
    RAISE EXCEPTION 'INVOICE_WRITTEN_OFF_STATUS_LOCKED: the written-off status changes only through a recorded customer loss or its storno'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_invoice_written_off_status
  BEFORE INSERT OR UPDATE OF status ON public.invoices
  FOR EACH ROW EXECUTE FUNCTION public.guard_invoice_written_off_status();

-- A kundförlust voucher's amounts and date are its decision's: an inline
-- rättelse of its lines (correct_entry_lines_inline sets
-- gnubok.allow_line_rattelse) or a new date (correct_entry_metadata) would
-- leave the row and the momsdeklaration describing another voucher. The way
-- back is a storno of the whole voucher (reverseEntry), which annuls the
-- decision. The TypeScript correction paths refuse the same
-- (CustomerLossVoucherLockedError in lib/core/bookkeeping/storno-service.ts).
CREATE OR REPLACE FUNCTION public.guard_customer_loss_voucher_lines()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = COALESCE(NEW.journal_entry_id, OLD.journal_entry_id)
      AND je.source_type = 'customer_loss'
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_LOCKED: a customer loss voucher is not corrected in place; reverse it instead'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$$;

-- Fires only inside an inline rättelse, so ordinary posting pays nothing.
CREATE TRIGGER guard_customer_loss_voucher_lines
  BEFORE INSERT OR UPDATE ON public.journal_entry_lines
  FOR EACH ROW
  WHEN (current_setting('gnubok.allow_line_rattelse', true) = 'true')
  EXECUTE FUNCTION public.guard_customer_loss_voucher_lines();

CREATE OR REPLACE FUNCTION public.guard_customer_loss_voucher_date()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $$
BEGIN
  RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_LOCKED: a customer loss voucher keeps its date; reverse it instead'
    USING ERRCODE = 'check_violation';
END;
$$;

CREATE TRIGGER guard_customer_loss_voucher_date
  BEFORE UPDATE OF entry_date ON public.journal_entries
  FOR EACH ROW
  WHEN (OLD.source_type = 'customer_loss' AND OLD.status = 'posted'
        AND NEW.entry_date IS DISTINCT FROM OLD.entry_date)
  EXECUTE FUNCTION public.guard_customer_loss_voucher_date();

-- =============================================================================
-- 6. record_invoice_write_off: the one writer
-- =============================================================================
-- Called by lib/customer-loss after the voucher is posted (or, for a never
-- booked kontantmetod invoice, without one). Validates the voucher against
-- the decision, takes the invoice row lock, inserts the row and moves the
-- status for konstaterad and for the annulment of a konstaterad decision.
-- Granted to the service role only (end of this section): no signed-in
-- person calls it directly, whatever CUSTOMER_LOSS_ENABLED says.
-- lib/customer-loss (write-off-rpc.ts) calls it after it has authenticated
-- the person and checked that they are a member of the company and not a
-- viewer, and names them in p_decided_by. The in-body check for a signed-in
-- caller stays as a second fence.
--
-- The row must say what its voucher booked, whoever calls: the reserve
-- (1519) and the receivable (151x) lines carry the row's amounts, the output
-- VAT lines (26xx) carry vat_by_rate account by account (the momsdeklaration
-- moves ruta 05 to 08 by those bases), a konstaterad decision without a
-- voucher is only for a claim that never reached the ledger, and an
-- annulment copies the amounts of the decision it annuls. So a direct call
-- that skips lib/customer-loss (and CUSTOMER_LOSS_ENABLED) can neither write
-- a booked claim off without a voucher nor move a ruta the ledger did not.

CREATE OR REPLACE FUNCTION public.record_invoice_write_off(
  p_id uuid,
  p_company_id uuid,
  p_invoice_id uuid,
  p_kind text,
  p_entry_date date,
  p_amount numeric,
  p_net_amount numeric,
  p_vat_amount numeric,
  p_vat_by_rate jsonb,
  p_reserve_released numeric,
  p_journal_entry_id uuid,
  p_evidence_document_id uuid,
  p_reason text,
  p_case_id uuid,
  p_reverses_id uuid,
  p_decided_by uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $$
DECLARE
  v_actor uuid := (SELECT auth.uid());
  v_decided_by uuid;
  v_invoice record;
  v_entry record;
  v_reversed record;
  v_status text;
  v_amount numeric := p_amount;
  v_net numeric := p_net_amount;
  v_vat numeric := COALESCE(p_vat_amount, 0);
  v_shares jsonb := COALESCE(p_vat_by_rate, '[]'::jsonb);
  v_released numeric := COALESCE(p_reserve_released, 0);
  v_reserve_cr numeric;
  v_receivable_cr numeric;
BEGIN
  IF v_actor IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.company_members m
      WHERE m.company_id = p_company_id AND m.user_id = v_actor AND m.role <> 'viewer'
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_FORBIDDEN: not a writer in this company'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_decided_by := v_actor;
  ELSE
    v_decided_by := p_decided_by;
  END IF;

  SELECT i.id, i.status, i.currency, i.paid_amount, i.due_date, i.journal_entry_id
    INTO v_invoice
    FROM public.invoices i
    WHERE i.id = p_invoice_id AND i.company_id = p_company_id
    FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_FOUND: invoice % not found in company %', p_invoice_id, p_company_id
      USING ERRCODE = 'no_data_found';
  END IF;
  IF COALESCE(v_invoice.currency, 'SEK') <> 'SEK' THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED: only SEK invoices'
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_journal_entry_id IS NOT NULL THEN
    SELECT je.id, je.status, je.source_type, je.source_id, je.reverses_id, je.entry_date
      INTO v_entry
      FROM public.journal_entries je
      WHERE je.id = p_journal_entry_id AND je.company_id = p_company_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: voucher % not found in company %', p_journal_entry_id, p_company_id
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_entry.entry_date <> p_entry_date THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: the row date must be the voucher date'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF p_evidence_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_attachments d
    WHERE d.id = p_evidence_document_id AND d.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_EVIDENCE_NOT_FOUND: document % not found in company %', p_evidence_document_id, p_company_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_case_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.collection_cases c
    WHERE c.id = p_case_id AND c.company_id = p_company_id AND c.invoice_id = p_invoice_id
  ) THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_CASE_MISMATCH: case % is not this invoice''s', p_case_id
      USING ERRCODE = 'check_violation';
  END IF;

  IF p_kind = 'annulled' THEN
    SELECT w.* INTO v_reversed
      FROM public.invoice_write_offs w
      WHERE w.id = p_reverses_id AND w.invoice_id = p_invoice_id AND w.company_id = p_company_id;
    IF NOT FOUND OR v_reversed.kind = 'annulled' OR v_reversed.journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_ANNUL_INVALID: nothing to annul'
        USING ERRCODE = 'check_violation';
    END IF;
    IF EXISTS (SELECT 1 FROM public.invoice_write_offs a WHERE a.reverses_id = v_reversed.id) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_ANNUL_INVALID: the decision is already annulled'
        USING ERRCODE = 'check_violation';
    END IF;
    IF p_journal_entry_id IS NULL THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: an annulment names the storno of the decision''s voucher'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_entry.source_type <> 'storno' OR v_entry.reverses_id IS DISTINCT FROM v_reversed.journal_entry_id THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: an annulment names the storno of the decision''s voucher'
        USING ERRCODE = 'check_violation';
    END IF;
    -- The annulment undoes exactly what the decision recorded.
    v_amount := v_reversed.amount;
    v_net := v_reversed.net_amount;
    v_vat := v_reversed.vat_amount;
    v_shares := v_reversed.vat_by_rate;
    v_released := v_reversed.reserve_released;
  ELSIF p_journal_entry_id IS NOT NULL THEN
    IF v_entry.source_type <> 'customer_loss' OR v_entry.source_id IS DISTINCT FROM p_id
       OR v_entry.status <> 'posted' THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: the voucher is not this decision''s posted customer_loss voucher'
        USING ERRCODE = 'check_violation';
    END IF;

    -- The reserve and receivable lines carry the row's amounts.
    SELECT
      COALESCE(sum(l.credit_amount - l.debit_amount) FILTER (WHERE l.account_number = '1519'), 0),
      COALESCE(sum(l.credit_amount - l.debit_amount) FILTER (
        WHERE l.account_number ~ '^151[0-9]$' AND l.account_number NOT IN ('1513', '1519')), 0)
      INTO v_reserve_cr, v_receivable_cr
      FROM public.journal_entry_lines l
      WHERE l.journal_entry_id = p_journal_entry_id;
    IF (p_kind = 'doubtful' AND (v_reserve_cr <> v_net OR v_receivable_cr <> 0))
       OR (p_kind = 'reversed_doubtful' AND (-v_reserve_cr <> v_net OR v_receivable_cr <> 0))
       OR (p_kind = 'confirmed' AND (v_receivable_cr <> v_amount OR -v_reserve_cr <> v_released))
       OR (p_kind = 'recovered' AND (v_receivable_cr <> 0 OR v_reserve_cr <> 0)) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: the voucher''s 1519 and 151x lines do not carry the decision''s amounts'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  -- The output VAT a konstaterad or recovery row records is what the
  -- momsdeklaration reads: well-formed shares that sum to vat_amount, each
  -- base matching its VAT at its rate, and account by account what the
  -- voucher moved on 26xx (debit for konstaterad, credit for a recovery).
  IF jsonb_typeof(v_shares) <> 'array' THEN
    RAISE EXCEPTION 'CUSTOMER_LOSS_VAT_MISMATCH: vat_by_rate is not a list'
      USING ERRCODE = 'check_violation';
  END IF;
  IF p_kind IN ('confirmed', 'recovered') THEN
    IF EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_shares) s
      WHERE jsonb_typeof(s) <> 'object'
         OR NOT (s ? 'account' AND s ? 'rate' AND s ? 'vat' AND s ? 'base')
         OR (s ->> 'account') !~ '^26[0-9]{2}$'
         OR (s ->> 'rate')::numeric NOT IN (25, 12, 6)
         OR (s ->> 'vat')::numeric <= 0
         OR abs((s ->> 'base')::numeric * (s ->> 'rate')::numeric / 100 - (s ->> 'vat')::numeric) > 0.01
    ) OR COALESCE((SELECT sum((s ->> 'vat')::numeric) FROM jsonb_array_elements(v_shares) s), 0) <> v_vat THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VAT_MISMATCH: vat_by_rate does not add up to vat_amount'
        USING ERRCODE = 'check_violation';
    END IF;

    IF p_journal_entry_id IS NULL THEN
      -- Only a claim that never reached the ledger as a fordran (kontantmetoden)
      -- is written off without a voucher, and it has no VAT to take back.
      IF v_vat <> 0 OR EXISTS (
        SELECT 1
          FROM public.journal_entries je
          JOIN public.journal_entry_lines l ON l.journal_entry_id = je.id
          WHERE je.id = v_invoice.journal_entry_id
            AND je.company_id = p_company_id
            AND je.status = 'posted'
            AND l.account_number ~ '^151[0-9]$'
            AND l.account_number NOT IN ('1513', '1519')
            AND l.debit_amount > 0
      ) THEN
        RAISE EXCEPTION 'CUSTOMER_LOSS_VOUCHER_MISMATCH: a claim on the ledger is written off by a voucher'
          USING ERRCODE = 'check_violation';
      END IF;
    ELSIF EXISTS (
      WITH booked AS (
        SELECT l.account_number AS account,
               sum(CASE WHEN p_kind = 'confirmed' THEN l.debit_amount - l.credit_amount
                        ELSE l.credit_amount - l.debit_amount END) AS vat
          FROM public.journal_entry_lines l
          WHERE l.journal_entry_id = p_journal_entry_id
            AND l.account_number ~ '^26[0-9]{2}$'
          GROUP BY l.account_number
      ), recorded AS (
        SELECT s ->> 'account' AS account, sum((s ->> 'vat')::numeric) AS vat
          FROM jsonb_array_elements(v_shares) s
          GROUP BY 1
      )
      SELECT 1
        FROM booked b
        FULL JOIN recorded r ON r.account = b.account
        WHERE COALESCE(b.vat, 0) <> COALESCE(r.vat, 0)
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_VAT_MISMATCH: the voucher''s output VAT lines differ from vat_by_rate'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  v_status := v_invoice.status;

  IF p_kind = 'doubtful' THEN
    IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_OPEN: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'confirmed' THEN
    IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_OPEN: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
    v_status := 'written_off';
  ELSIF p_kind = 'recovered' THEN
    IF v_invoice.status <> 'written_off' THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_NOT_WRITTEN_OFF: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'reversed_doubtful' THEN
    IF v_invoice.status IN ('draft', 'cancelled') THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_INVOICE_NOT_OPEN: invoice status %', v_invoice.status
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF p_kind = 'annulled' THEN
    -- Undo in order: only the latest live decision on the invoice.
    IF EXISTS (
      SELECT 1 FROM public.invoice_write_offs w
      WHERE w.invoice_id = p_invoice_id
        AND w.kind <> 'annulled'
        AND w.id <> v_reversed.id
        AND w.decided_at > v_reversed.decided_at
        AND NOT EXISTS (SELECT 1 FROM public.invoice_write_offs a WHERE a.reverses_id = w.id)
    ) THEN
      RAISE EXCEPTION 'CUSTOMER_LOSS_ANNUL_NOT_LATEST: a later decision on the invoice must be reversed first'
        USING ERRCODE = 'check_violation';
    END IF;
    IF v_reversed.kind = 'confirmed' THEN
      IF v_invoice.status <> 'written_off' THEN
        RAISE EXCEPTION 'CUSTOMER_LOSS_NOT_WRITTEN_OFF: invoice status %', v_invoice.status
          USING ERRCODE = 'check_violation';
      END IF;
      v_status := CASE
        WHEN COALESCE(v_invoice.paid_amount, 0) > 0 THEN 'partially_paid'
        WHEN v_invoice.due_date < CURRENT_DATE THEN 'overdue'
        ELSE 'sent'
      END;
    END IF;
  ELSE
    RAISE EXCEPTION 'CUSTOMER_LOSS_KIND_INVALID: %', p_kind USING ERRCODE = 'check_violation';
  END IF;

  INSERT INTO public.invoice_write_offs (
    id, company_id, invoice_id, kind, entry_date, amount, net_amount, vat_amount,
    vat_by_rate, reserve_released, journal_entry_id, evidence_document_id, reason,
    case_id, reverses_id, decided_by
  ) VALUES (
    p_id, p_company_id, p_invoice_id, p_kind, p_entry_date, v_amount, v_net,
    v_vat, v_shares, v_released,
    p_journal_entry_id, p_evidence_document_id, p_reason, p_case_id, p_reverses_id, v_decided_by
  );

  IF v_status IS DISTINCT FROM v_invoice.status THEN
    PERFORM pg_catalog.set_config('gnubok.customer_loss_status', 'true', true);
    UPDATE public.invoices SET status = v_status WHERE id = p_invoice_id;
    PERFORM pg_catalog.set_config('gnubok.customer_loss_status', '', true);
  END IF;

  RETURN jsonb_build_object('id', p_id, 'invoice_status', v_status);
END;
$$;

REVOKE ALL ON FUNCTION public.record_invoice_write_off(
  uuid, uuid, uuid, text, date, numeric, numeric, numeric, jsonb, numeric, uuid, uuid, text, uuid, uuid, uuid
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_invoice_write_off(
  uuid, uuid, uuid, text, date, numeric, numeric, numeric, jsonb, numeric, uuid, uuid, text, uuid, uuid, uuid
) TO service_role;

-- =============================================================================
-- 7. cleanup_sandbox_user: the write-off rows
-- =============================================================================
-- Rebuilt from 20261021120000_collection_settlements.sql (the latest
-- definition). The only change: the write-off rows go with the other WORM
-- logs, first, while company_settings still exists (their delete guard
-- re-verifies the sandbox through it) and before the documents, vouchers,
-- cases and invoices they hold RESTRICT references to.

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
  -- Kundförlust decisions (20261021120700): RESTRICT references to documents,
  -- vouchers, cases and invoices.
  DELETE FROM public.invoice_write_offs WHERE company_id = ANY(v_companies);
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
  -- Collected payments and settlements (20261021120000) hold RESTRICT
  -- references to their vouchers, archived documents, invoices, cases and
  -- connection: they go before all of those (the lines go with their
  -- settlement).
  DELETE FROM public.collection_collected_payments WHERE company_id = ANY(v_companies);
  DELETE FROM public.collection_settlements WHERE company_id = ANY(v_companies);
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

-- =============================================================================
-- 8. collection_collected_payments: a payment booked as a recovery
-- =============================================================================
-- A payment the collections provider collected on a written-off invoice is
-- booked as återvunnen kundförlust (Dr the connection's clearing account /
-- Cr 3950 net and Cr 26xx, lib/collections/collected-payments.ts), not as a
-- payment of the invoice: no invoice_payments row stands behind it, the
-- recovered decision does. The booked shape from
-- 20261021120000_collection_settlements.sql accepts either, never both. No
-- foreign key, like invoice_payment_id: the rebook puts the payment back to
-- pending and the next booking records a new decision, and the sandbox
-- teardown deletes the decision rows before the collected payments.

ALTER TABLE public.collection_collected_payments
  ADD COLUMN write_off_id uuid;

COMMENT ON COLUMN public.collection_collected_payments.write_off_id IS
  'The recovered kundförlust decision (invoice_write_offs.id) this payment was booked as, on a written-off invoice; invoice_payment_id is null then.';

ALTER TABLE public.collection_collected_payments
  DROP CONSTRAINT collection_collected_payments_booked_shape;

ALTER TABLE public.collection_collected_payments
  ADD CONSTRAINT collection_collected_payments_booked_shape CHECK (
    (status = 'booked') = (booked_at IS NOT NULL AND (invoice_payment_id IS NOT NULL OR write_off_id IS NOT NULL))
  ),
  ADD CONSTRAINT collection_collected_payments_one_booking CHECK (
    invoice_payment_id IS NULL OR write_off_id IS NULL
  );

NOTIFY pgrst, 'reload schema';
