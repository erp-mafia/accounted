-- Arkiv phase 5 (dev_docs/arkiv_plan.md): the record as dated, sourced facts,
-- curated by people and agents, read by the behandlingshistorik report.
--
-- company_facts is bitemporal: valid_from/valid_to say when a fact is true
-- in the world, sys_from/sys_to say when the system believed it. Rows are
-- never deleted and never edited in place: a new reading supersedes the old
-- one (sys_to closed, supersedes_id set), a wrong value is deprecated with a
-- reason, and a proposal is confirmed by the person who approved it. The
-- guard trigger allows exactly those three updates. One live value per
-- single-valued predicate and validity window, enforced by an exclusion
-- constraint. Agents never write here directly: they stage
-- arkiv_propose_fact in pending_operations, and the commit records the fact
-- with the approver as approved_by.

CREATE EXTENSION IF NOT EXISTS btree_gist;

CREATE TABLE public.company_facts (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('company', 'agreement', 'party')),
  -- the agreement or party; the company itself when subject_kind = 'company'
  subject_id uuid NOT NULL,
  -- controlled vocabulary in lib/arkiv/facts/predicates.ts
  predicate text NOT NULL CHECK (predicate ~ '^[a-z][a-z0-9_]{1,63}$'),
  value jsonb NOT NULL,
  -- flattened for search and display
  value_text text NOT NULL,
  single_valued boolean NOT NULL DEFAULT true,
  valid_from date,
  valid_to date,
  sys_from timestamptz NOT NULL DEFAULT now(),
  sys_to timestamptz,
  rank text NOT NULL DEFAULT 'normal' CHECK (rank IN ('preferred', 'normal', 'deprecated')),
  deprecation_reason text,
  supersedes_id uuid REFERENCES public.company_facts(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('proposed', 'confirmed')),
  -- extraction: settled fields of a record; ledger: derived from posted entries; registry: an authority; person; agent: a proposal a person approved
  source_kind text NOT NULL CHECK (source_kind IN ('extraction', 'ledger', 'registry', 'person', 'agent')),
  source_document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  source_extraction_id uuid REFERENCES public.document_extractions(id) ON DELETE SET NULL,
  -- [{ document_id, page, quote, extraction_id, at }]; new evidence for the same value appends here
  sources jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(4, 3) NOT NULL DEFAULT 1 CHECK (confidence >= 0 AND confidence <= 1),
  rationale text,
  asserted_by_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  approved_by_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from),
  CHECK (sys_to IS NULL OR sys_to >= sys_from),
  CHECK (rank <> 'deprecated' OR deprecation_reason IS NOT NULL),
  CHECK (status <> 'confirmed' OR source_kind <> 'agent' OR approved_by_user_id IS NOT NULL),
  -- one live, undeprecated value per single-valued predicate and validity window
  EXCLUDE USING gist (
    company_id WITH =,
    subject_kind WITH =,
    subject_id WITH =,
    predicate WITH =,
    daterange(valid_from, valid_to, '[]') WITH &&
  ) WHERE (sys_to IS NULL AND rank <> 'deprecated' AND status = 'confirmed' AND single_valued)
);
CREATE INDEX idx_company_facts_subject ON public.company_facts (company_id, subject_kind, subject_id, predicate) WHERE sys_to IS NULL;
CREATE INDEX idx_company_facts_document ON public.company_facts (source_document_id) WHERE source_document_id IS NOT NULL;
CREATE INDEX idx_company_facts_history ON public.company_facts (company_id, sys_from DESC);
ALTER TABLE public.company_facts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "view own-company facts"
  ON public.company_facts FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
-- Writes: service role only, through the two functions below.

-- The only updates a fact ever takes: closing its belief window, being
-- deprecated with a reason, being confirmed by a person, or gaining evidence.
CREATE OR REPLACE FUNCTION public.company_facts_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'company_facts rows are never deleted; deprecate or supersede instead' USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW.id <> OLD.id OR NEW.company_id <> OLD.company_id OR NEW.subject_kind <> OLD.subject_kind OR NEW.subject_id <> OLD.subject_id
     OR NEW.predicate <> OLD.predicate OR NEW.value <> OLD.value OR NEW.value_text <> OLD.value_text
     OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.valid_to IS DISTINCT FROM OLD.valid_to
     OR NEW.sys_from <> OLD.sys_from OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
     OR NEW.source_kind <> OLD.source_kind OR NEW.source_document_id IS DISTINCT FROM OLD.source_document_id
     OR NEW.source_extraction_id IS DISTINCT FROM OLD.source_extraction_id OR NEW.created_at <> OLD.created_at
     OR NEW.asserted_by_agent_id IS DISTINCT FROM OLD.asserted_by_agent_id THEN
    RAISE EXCEPTION 'company_facts rows are immutable apart from closing, deprecating, confirming and adding evidence' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.sys_to IS NOT NULL AND NEW.sys_to IS DISTINCT FROM OLD.sys_to THEN
    RAISE EXCEPTION 'a closed fact stays closed' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.rank = 'deprecated' AND NEW.rank <> 'deprecated' THEN
    RAISE EXCEPTION 'a deprecated fact stays deprecated; record a new one' USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD.status = 'confirmed' AND NEW.status <> 'confirmed' THEN
    RAISE EXCEPTION 'a confirmed fact cannot go back to proposed' USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER company_facts_guard BEFORE UPDATE OR DELETE ON public.company_facts
  FOR EACH ROW EXECUTE FUNCTION public.company_facts_guard();

-- Records a fact. The same value already live for the same window only gains
-- the new evidence; a different value closes the live single-valued fact and
-- supersedes it. Returns the id of the fact that now carries the value.
CREATE OR REPLACE FUNCTION public.record_company_fact(
  p_company_id uuid,
  p_subject_kind text,
  p_subject_id uuid,
  p_predicate text,
  p_value jsonb,
  p_value_text text,
  p_single_valued boolean,
  p_valid_from date,
  p_valid_to date,
  p_source_kind text,
  p_source_document_id uuid,
  p_source_extraction_id uuid,
  p_evidence jsonb,
  p_confidence numeric,
  p_rationale text,
  p_asserted_by_agent_id uuid,
  p_approved_by_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_same uuid;
  v_prev uuid;
  v_id uuid;
BEGIN
  SELECT id INTO v_same
    FROM public.company_facts
   WHERE company_id = p_company_id AND subject_kind = p_subject_kind AND subject_id = p_subject_id
     AND predicate = p_predicate AND value = p_value
     AND valid_from IS NOT DISTINCT FROM p_valid_from AND valid_to IS NOT DISTINCT FROM p_valid_to
     AND sys_to IS NULL AND rank <> 'deprecated'
   LIMIT 1;
  IF v_same IS NOT NULL THEN
    IF p_evidence IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.company_facts f, jsonb_array_elements(f.sources) s
       WHERE f.id = v_same AND s->>'document_id' IS NOT DISTINCT FROM p_evidence->>'document_id' AND s->>'page' IS NOT DISTINCT FROM p_evidence->>'page'
    ) THEN
      UPDATE public.company_facts SET sources = sources || jsonb_build_array(p_evidence) WHERE id = v_same;
    END IF;
    RETURN v_same;
  END IF;

  IF p_single_valued THEN
    -- Close what this reading replaces; the first closed row is the one superseded.
    WITH closed AS (
      UPDATE public.company_facts
         SET sys_to = now()
       WHERE company_id = p_company_id AND subject_kind = p_subject_kind AND subject_id = p_subject_id
         AND predicate = p_predicate AND single_valued AND sys_to IS NULL AND rank <> 'deprecated' AND status = 'confirmed'
         AND daterange(valid_from, valid_to, '[]') && daterange(p_valid_from, p_valid_to, '[]')
      RETURNING id
    )
    SELECT id INTO v_prev FROM closed ORDER BY id LIMIT 1;
  END IF;

  INSERT INTO public.company_facts
    (company_id, subject_kind, subject_id, predicate, value, value_text, single_valued, valid_from, valid_to,
     supersedes_id, status, source_kind, source_document_id, source_extraction_id, sources, confidence, rationale,
     asserted_by_agent_id, approved_by_user_id)
  VALUES
    (p_company_id, p_subject_kind, p_subject_id, p_predicate, p_value, p_value_text, p_single_valued, p_valid_from, p_valid_to,
     v_prev, 'confirmed', p_source_kind, p_source_document_id, p_source_extraction_id,
     CASE WHEN p_evidence IS NULL THEN '[]'::jsonb ELSE jsonb_build_array(p_evidence) END,
     coalesce(p_confidence, 1), p_rationale, p_asserted_by_agent_id, p_approved_by_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.record_company_fact(uuid, text, uuid, text, jsonb, text, boolean, date, date, text, uuid, uuid, jsonb, numeric, text, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_company_fact(uuid, text, uuid, text, jsonb, text, boolean, date, date, text, uuid, uuid, jsonb, numeric, text, uuid, uuid) TO service_role;
COMMENT ON FUNCTION public.record_company_fact(uuid, text, uuid, text, jsonb, text, boolean, date, date, text, uuid, uuid, jsonb, numeric, text, uuid, uuid) IS
  'Arkiv: records a company fact with supersession of the live single-valued value for the same subject, predicate and validity. Service role only.';

-- Rollback in one command: the fact is deprecated with the reason, and the
-- fact it superseded (if any) is reinstated as a new live row.
CREATE OR REPLACE FUNCTION public.revert_company_fact(p_fact_id uuid, p_reason text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_fact public.company_facts%ROWTYPE;
  v_prev public.company_facts%ROWTYPE;
  v_id uuid;
BEGIN
  SELECT * INTO v_fact FROM public.company_facts WHERE id = p_fact_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'fact % not found', p_fact_id USING ERRCODE = 'no_data_found';
  END IF;
  IF v_fact.rank = 'deprecated' THEN
    RETURN NULL;
  END IF;
  UPDATE public.company_facts SET rank = 'deprecated', deprecation_reason = coalesce(nullif(btrim(p_reason), ''), 'reverted'), sys_to = coalesce(sys_to, now())
   WHERE id = p_fact_id;
  IF v_fact.supersedes_id IS NULL THEN
    RETURN NULL;
  END IF;
  SELECT * INTO v_prev FROM public.company_facts WHERE id = v_fact.supersedes_id;
  IF NOT FOUND OR v_prev.rank = 'deprecated' THEN
    RETURN NULL;
  END IF;
  INSERT INTO public.company_facts
    (company_id, subject_kind, subject_id, predicate, value, value_text, single_valued, valid_from, valid_to,
     supersedes_id, status, source_kind, source_document_id, source_extraction_id, sources, confidence, rationale,
     asserted_by_agent_id, approved_by_user_id)
  VALUES
    (v_prev.company_id, v_prev.subject_kind, v_prev.subject_id, v_prev.predicate, v_prev.value, v_prev.value_text, v_prev.single_valued,
     v_prev.valid_from, v_prev.valid_to, p_fact_id, v_prev.status, v_prev.source_kind, v_prev.source_document_id, v_prev.source_extraction_id,
     v_prev.sources, v_prev.confidence, 'reinstated: ' || coalesce(nullif(btrim(p_reason), ''), 'reverted'), v_prev.asserted_by_agent_id, v_prev.approved_by_user_id)
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION public.revert_company_fact(uuid, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.revert_company_fact(uuid, text) TO service_role;
COMMENT ON FUNCTION public.revert_company_fact(uuid, text) IS
  'Arkiv: deprecates a fact with a reason and reinstates the fact it superseded. Service role only.';

-- Agents propose facts through the staged-operation flow (change proposals).
ALTER TABLE public.pending_operations DROP CONSTRAINT IF EXISTS pending_operations_operation_type_check;
ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check
  CHECK (operation_type IN (
    'categorize_transaction', 'create_customer', 'create_invoice', 'mark_invoice_paid', 'send_invoice', 'mark_invoice_sent',
    'match_transaction_invoice', 'close_period', 'lock_period', 'unlock_period', 'set_opening_balances', 'run_year_end',
    'post_kontantmetod_cutoff', 'run_currency_revaluation', 'import_sie', 'explain_voucher_gap', 'uncategorize_transaction',
    'approve_supplier_invoice', 'credit_supplier_invoice', 'credit_invoice', 'convert_invoice', 'delete_draft_invoice',
    'create_transaction', 'attach_document_to_transaction', 'create_voucher', 'correct_entry', 'reverse_entry', 'create_supplier',
    'create_supplier_invoice_from_inbox', 'post_annual_depreciation', 'link_invoice_voucher', 'undo_sie_import', 'match_batch_allocate',
    'bulk_book_transactions', 'create_salary_run', 'generate_agi', 'link_transaction_journal_entry', 'link_supplier_invoice_voucher',
    'submit_vat_declaration', 'submit_agi', 'create_article', 'update_article', 'bulk_book_inbox_items', 'create_dimension_value',
    'retag_line_dimensions', 'link_document_to_voucher', 'update_payslip_line', 'set_run_salary', 'update_salary_run', 'register_absence',
    'create_employee', 'update_employee', 'set_employee_opening_balances', 'vacation_year_close', 'create_account', 'update_account',
    'set_voucher_note', 'book_salary_run', 'delete_absence', 'update_company_settings', 'update_customer', 'update_invoice',
    'create_recurring_schedule', 'update_recurring_schedule', 'log_mileage_trip', 'book_mileage_period', 'link_documents_to_vouchers',
    'reconciliation_match', 'reconciliation_unmatch', 'reconciliation_signoff', 'reconciliation_residual', 'book_skattekonto_row',
    'book_skattekonto_rows', 'ignore_transaction', 'create_sales_order', 'transition_sales_order', 'register_sales_order_delivery',
    'create_invoice_from_sales_order', 'settle_rot_rut_payout',
    'arkiv_propose_fact'
  )) NOT VALID;

NOTIFY pgrst, 'reload schema';
