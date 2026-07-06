-- Rot & rut: begäran om utbetalning (Skatteverkets husavdragstjänst)
--
-- Tracks generated payout-request files (HUS XML, schema V6 — see
-- dev_docs/skatteverket/husavdrag/) so an invoice can never end up in two
-- active begäran, and so the Skatteverket outcome (utbetalt/avslag) can be
-- recorded and settled against BAS 1513.
--
-- Also adds invoice_items.brf_org_number: ROT i bostadsrätt is reported with
-- bostadsrättsföreningens orgnr + lägenhetsnummer instead of
-- fastighetsbeteckning (BegaranCOMPONENT.xsd: BrfOrgNr, max 12 chars).

-- =============================================================================
-- 1. invoice_items.brf_org_number
-- =============================================================================
ALTER TABLE public.invoice_items
  ADD COLUMN IF NOT EXISTS brf_org_number TEXT NULL;

-- Format (digits/dash, XSD BrfOrgNrTYPE) is validated at the API layer via
-- Zod, same approach as the other ROT/RUT columns (20260526121700). The DB
-- only guards the hard XSD length cap.
ALTER TABLE public.invoice_items DROP CONSTRAINT IF EXISTS invoice_items_brf_org_number_check;
ALTER TABLE public.invoice_items ADD CONSTRAINT invoice_items_brf_org_number_check
  CHECK (brf_org_number IS NULL OR char_length(brf_org_number) <= 12);

-- =============================================================================
-- 2. rot_rut_payout_requests — one row per generated begäran-fil
-- =============================================================================
CREATE TABLE public.rot_rut_payout_requests (
  id             uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id     uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  deduction_type TEXT NOT NULL CHECK (deduction_type IN ('rot', 'rut')),

  -- NamnPaBegaranTYPE: 1–16 chars, shown in Skatteverkets e-tjänst.
  name           TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 16),

  -- Lifecycle: generated → submitted → paid | partially_paid | rejected.
  -- cancelled is allowed from generated/submitted (file never uploaded, or
  -- withdrawn before beslut). Transitions are enforced at the API layer;
  -- the DB constrains the value set.
  status         TEXT NOT NULL DEFAULT 'generated' CHECK (status IN (
    'generated', 'submitted', 'paid', 'partially_paid', 'rejected', 'cancelled'
  )),

  -- Sum of item requested_amount (kr). Denormalized for list views.
  requested_total NUMERIC(12,2) NOT NULL CHECK (requested_total >= 0),
  -- Filled in when Skatteverkets beslut is recorded.
  decided_total   NUMERIC(12,2) NULL CHECK (decided_total >= 0),

  -- The archived XML file (räkenskapsinformation, 7-year retention via the
  -- document_attachments WORM chain).
  file_name        TEXT NOT NULL,
  file_document_id uuid NULL REFERENCES public.document_attachments(id) ON DELETE SET NULL,

  -- Settlement voucher (debit 1930 / credit 1513) once utbetalningen booked.
  settlement_journal_entry_id uuid NULL REFERENCES public.journal_entries(id) ON DELETE SET NULL,

  submitted_at   timestamptz NULL,
  decided_at     timestamptz NULL,

  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.rot_rut_payout_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company rot_rut_payout_requests"
  ON public.rot_rut_payout_requests FOR SELECT
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company rot_rut_payout_requests"
  ON public.rot_rut_payout_requests FOR INSERT
  WITH CHECK (company_id IN (SELECT user_company_ids()));
CREATE POLICY "update own-company rot_rut_payout_requests"
  ON public.rot_rut_payout_requests FOR UPDATE
  USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "delete own-company rot_rut_payout_requests"
  ON public.rot_rut_payout_requests FOR DELETE
  USING (company_id IN (SELECT user_company_ids()));

CREATE INDEX idx_rot_rut_payout_requests_company_id
  ON public.rot_rut_payout_requests (company_id);
CREATE INDEX idx_rot_rut_payout_requests_company_status
  ON public.rot_rut_payout_requests (company_id, status);

CREATE TRIGGER set_updated_at_rot_rut_payout_requests
  BEFORE UPDATE ON public.rot_rut_payout_requests
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_rot_rut_payout_requests
  AFTER INSERT OR UPDATE OR DELETE ON public.rot_rut_payout_requests
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 3. rot_rut_payout_request_items — one row per (request, invoice)
-- =============================================================================
CREATE TABLE public.rot_rut_payout_request_items (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  request_id       uuid NOT NULL REFERENCES public.rot_rut_payout_requests(id) ON DELETE CASCADE,
  -- RESTRICT: an invoice referenced by a begäran is bokföringsunderlag and
  -- must not disappear from under the request.
  invoice_id       uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,

  -- BegartBelopp for this invoice (kr, whole kronor in the file; stored with
  -- öre precision because it mirrors invoices.deduction_total).
  requested_amount NUMERIC(12,2) NOT NULL CHECK (requested_amount > 0),
  -- Godkänt belopp from Skatteverkets beslut (null until decided).
  decided_amount   NUMERIC(12,2) NULL CHECK (decided_amount >= 0),

  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  UNIQUE (request_id, invoice_id)
);

ALTER TABLE public.rot_rut_payout_request_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "view own-company rot_rut_payout_request_items"
  ON public.rot_rut_payout_request_items FOR SELECT
  USING (EXISTS (
    SELECT 1 FROM public.rot_rut_payout_requests r
    WHERE r.id = rot_rut_payout_request_items.request_id
      AND r.company_id IN (SELECT user_company_ids())
  ));
CREATE POLICY "insert own-company rot_rut_payout_request_items"
  ON public.rot_rut_payout_request_items FOR INSERT
  WITH CHECK (EXISTS (
    SELECT 1 FROM public.rot_rut_payout_requests r
    WHERE r.id = rot_rut_payout_request_items.request_id
      AND r.company_id IN (SELECT user_company_ids())
  ));
CREATE POLICY "update own-company rot_rut_payout_request_items"
  ON public.rot_rut_payout_request_items FOR UPDATE
  USING (EXISTS (
    SELECT 1 FROM public.rot_rut_payout_requests r
    WHERE r.id = rot_rut_payout_request_items.request_id
      AND r.company_id IN (SELECT user_company_ids())
  ));
CREATE POLICY "delete own-company rot_rut_payout_request_items"
  ON public.rot_rut_payout_request_items FOR DELETE
  USING (EXISTS (
    SELECT 1 FROM public.rot_rut_payout_requests r
    WHERE r.id = rot_rut_payout_request_items.request_id
      AND r.company_id IN (SELECT user_company_ids())
  ));

CREATE INDEX idx_rot_rut_payout_request_items_request_id
  ON public.rot_rut_payout_request_items (request_id);
CREATE INDEX idx_rot_rut_payout_request_items_invoice_id
  ON public.rot_rut_payout_request_items (invoice_id);

CREATE TRIGGER set_updated_at_rot_rut_payout_request_items
  BEFORE UPDATE ON public.rot_rut_payout_request_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_rot_rut_payout_request_items
  AFTER INSERT OR UPDATE OR DELETE ON public.rot_rut_payout_request_items
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. Integrity guard: one active begäran per invoice + same-company check
--
-- An invoice may appear in any number of cancelled/rejected requests (retry
-- after avslag) but in at most ONE active (generated/submitted/paid/
-- partially_paid) request — otherwise the same deduction could be requested
-- twice. Cross-table invariants can't be expressed as a UNIQUE index across
-- a JOIN, hence the trigger.
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_single_active_rot_rut_request()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_request_company uuid;
  v_invoice_company uuid;
BEGIN
  SELECT company_id INTO v_request_company
  FROM public.rot_rut_payout_requests
  WHERE id = NEW.request_id;

  SELECT company_id INTO v_invoice_company
  FROM public.invoices
  WHERE id = NEW.invoice_id;

  IF v_invoice_company IS NULL OR v_invoice_company != v_request_company THEN
    RAISE EXCEPTION 'Invoice % does not belong to the same company as payout request %',
      NEW.invoice_id, NEW.request_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.rot_rut_payout_request_items i
    JOIN public.rot_rut_payout_requests r ON r.id = i.request_id
    WHERE i.invoice_id = NEW.invoice_id
      AND i.id != NEW.id
      AND r.status NOT IN ('cancelled', 'rejected')
  ) THEN
    RAISE EXCEPTION 'Invoice % is already included in an active rot/rut payout request',
      NEW.invoice_id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_single_active_rot_rut_request
  BEFORE INSERT OR UPDATE OF invoice_id, request_id ON public.rot_rut_payout_request_items
  FOR EACH ROW EXECUTE FUNCTION public.enforce_single_active_rot_rut_request();

-- The item-level trigger can be bypassed by flipping a cancelled/rejected
-- request back to an active status while its invoices have meanwhile been
-- included in another active request. Guard the reactivation path too.
CREATE OR REPLACE FUNCTION public.enforce_rot_rut_request_reactivation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IN ('cancelled', 'rejected')
     AND NEW.status NOT IN ('cancelled', 'rejected')
     AND EXISTS (
       SELECT 1
       FROM public.rot_rut_payout_request_items mine
       JOIN public.rot_rut_payout_request_items other
         ON other.invoice_id = mine.invoice_id AND other.request_id != mine.request_id
       JOIN public.rot_rut_payout_requests r ON r.id = other.request_id
       WHERE mine.request_id = NEW.id
         AND r.status NOT IN ('cancelled', 'rejected')
     ) THEN
    RAISE EXCEPTION 'Cannot reactivate payout request %: an invoice is already included in another active request',
      NEW.id
      USING ERRCODE = '23505';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_rot_rut_request_reactivation
  BEFORE UPDATE OF status ON public.rot_rut_payout_requests
  FOR EACH ROW EXECUTE FUNCTION public.enforce_rot_rut_request_reactivation();

-- =============================================================================
-- 5. journal_entries.source_type: add 'rot_rut_payout' for the settlement
--    voucher (debit 1930 / credit 1513) booked when Skatteverket pays out.
-- =============================================================================
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
    'rot_rut_payout'
  ));

-- Reload PostgREST schema cache
NOTIFY pgrst, 'reload schema';
