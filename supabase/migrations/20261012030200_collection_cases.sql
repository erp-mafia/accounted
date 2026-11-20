-- Collections cases: one row per invoice handed over to the collections
-- provider the company activated (collection_connections), the case's
-- append-only trail, the functions the invoice list, Att göra and the
-- connection guard read, and the guards that keep a case tied to a real,
-- unpaid customer invoice.
-- pg-test: tests/pg/collection-cases.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts,
--          tests/pg/full-archive-coverage.pg.test.ts
--
-- invoices.status is never changed by a handover: "Hos inkasso" is derived
-- from an open case past the delivery stages (collection_open_invoice_ids).
--
-- The case row is written before the provider is called (reserve pattern):
-- its id is the idempotency key and the provider's case reference, so a
-- timed-out call is completed by the sync cron with the same key. While the
-- call is outstanding the row holds the request it sent in
-- submission_request, without the debtor's personal identity number and
-- without the PDF bytes (both are re-read for a retry), and the column is
-- cleared once the provider registered or refused the case.
--
-- Writes go through the service role (session routes, the staged-operation
-- commit path and the sync cron); members read their company's rows through
-- RLS. The trail is append-only: it is the company's own record of what was
-- demanded of its customer. Debtor-identifying content never enters it.

-- =============================================================================
-- 1. collection_cases
-- =============================================================================

CREATE TABLE public.collection_cases (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  connection_id uuid NOT NULL REFERENCES public.collection_connections(id) ON DELETE RESTRICT,

  -- How the case came about, and where the provider starts.
  origin text NOT NULL CHECK (origin IN ('handover', 'batch', 'distribution')),
  start_step text NOT NULL CHECK (start_step IN ('invoice', 'reminder', 'collection')),

  -- preparing: the row exists, the provider has not been called.
  -- submitted: the call is in flight or timed out; retried with the same key.
  -- registered: the provider holds the case.
  -- failed: the provider refused it (the case is closed; a retry is a new case).
  submission_status text NOT NULL DEFAULT 'preparing'
    CHECK (submission_status IN ('preparing', 'submitted', 'registered', 'failed')),
  submission_request jsonb,
  submission_attempts integer NOT NULL DEFAULT 0 CHECK (submission_attempts >= 0),

  -- The provider's opaque handles: the ledger keeps them, Connect only hashes.
  provider_case_ref text CHECK (provider_case_ref IS NULL OR length(provider_case_ref) BETWEEN 1 AND 128),
  provider_case_number text CHECK (provider_case_number IS NULL OR length(provider_case_number) <= 64),
  parent_case_ref text CHECK (parent_case_ref IS NULL OR length(parent_case_ref) <= 128),

  -- The provider-neutral stage (contract collectionsStageSchema) and what the
  -- provider waits for while the stage is awaiting_decision.
  stage text NOT NULL DEFAULT 'registered'
    CHECK (stage IN ('registered', 'invoice_sent', 'reminder', 'collection', 'awaiting_decision',
                     'enforcement', 'payment_plan', 'monitoring', 'paused', 'closed_paid',
                     'closed_other', 'unknown')),
  decision_kind text
    CHECK (decision_kind IN ('approve_reminder', 'approve_collection_notice', 'legal_action',
                             'legal_action_not_recommended', 'dispute', 'debtor_says_paid', 'other')),
  is_open boolean NOT NULL DEFAULT true,
  close_reason text
    CHECK (close_reason IN ('paid', 'withdrawn', 'credited', 'insolvent', 'bankrupt', 'deceased',
                            'moved_abroad', 'error', 'other')),
  provider_state text,
  provider_state_label text,
  next_action_date date,
  next_action_label text,
  -- The actions the provider's last snapshot offered: the card shows only these.
  actions text[] NOT NULL DEFAULT '{}',

  -- What the customer was asked to pay (their share after ROT/RUT, as printed).
  claim_amount numeric(14,2) NOT NULL CHECK (claim_amount > 0),
  currency text NOT NULL DEFAULT 'SEK' CHECK (currency = 'SEK'),
  outstanding_principal numeric(14,2),
  outstanding_total numeric(14,2),

  -- The "may already be paid" check at handover: {checked_at, outcome,
  -- payee_accounts, candidate_transaction_ids, dismissed, attested_by,
  -- attested_at, delivered_outcome, imported_attestation, response_attestation}.
  bank_check jsonb NOT NULL,
  -- Each escalation the company approves (start, approve_step) re-runs it.
  last_bank_checked_at timestamptz,

  paused_by_sweep boolean NOT NULL DEFAULT false,
  pause_reason text,

  opened_by uuid REFERENCES auth.users(id),
  opened_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz,
  last_synced_at timestamptz,
  sync_error text,
  pending_operation_id uuid REFERENCES public.pending_operations(id) ON DELETE SET NULL,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_cases_open_shape CHECK (is_open = (closed_at IS NULL)),
  CONSTRAINT collection_cases_failed_closed CHECK (submission_status <> 'failed' OR NOT is_open),
  CONSTRAINT collection_cases_closed_stage CHECK (stage NOT IN ('closed_paid', 'closed_other') OR NOT is_open),
  CONSTRAINT collection_cases_close_reason_shape CHECK (close_reason IS NULL OR NOT is_open),
  CONSTRAINT collection_cases_decision_shape CHECK (decision_kind IS NULL OR stage = 'awaiting_decision'),
  CONSTRAINT collection_cases_registered_ref CHECK (submission_status <> 'registered' OR provider_case_ref IS NOT NULL),
  CONSTRAINT collection_cases_request_in_flight CHECK (
    submission_request IS NULL OR submission_status IN ('preparing', 'submitted')
  )
);

COMMENT ON TABLE public.collection_cases IS
  'One row per invoice handed over to the collections provider. Provider-neutral; invoices.status is never changed by a handover.';
COMMENT ON COLUMN public.collection_cases.submission_request IS
  'The open-case request while it is in flight, without the personal identity number and the PDF bytes; cleared once the provider registered or refused the case.';
COMMENT ON COLUMN public.collection_cases.provider_case_ref IS
  'The provider''s opaque case handle. The only clear copy: Connect stores a hash.';

-- One open case per invoice; a re-opened claim after a withdrawal is a new case.
CREATE UNIQUE INDEX collection_cases_one_open_per_invoice
  ON public.collection_cases (invoice_id)
  WHERE is_open;
CREATE UNIQUE INDEX collection_cases_provider_ref
  ON public.collection_cases (company_id, provider_case_ref)
  WHERE provider_case_ref IS NOT NULL;
CREATE INDEX collection_cases_company_open
  ON public.collection_cases (company_id, stage)
  WHERE is_open;
CREATE INDEX collection_cases_invoice ON public.collection_cases (invoice_id, created_at DESC);
CREATE INDEX collection_cases_connection ON public.collection_cases (connection_id);
-- The sync cron: in-flight submissions, and open cases by staleness.
CREATE INDEX collection_cases_in_flight
  ON public.collection_cases (updated_at)
  WHERE submission_status IN ('preparing', 'submitted');
CREATE INDEX collection_cases_sync_due
  ON public.collection_cases (last_synced_at NULLS FIRST)
  WHERE is_open AND submission_status = 'registered';

ALTER TABLE public.collection_cases ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_cases_select" ON public.collection_cases
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_cases TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_cases TO service_role;
-- no-grant: anon on public.collection_cases (company data)

CREATE TRIGGER collection_cases_updated_at
  BEFORE UPDATE ON public.collection_cases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A case is opened only for a real customer invoice of the same company that
-- is issued and still owed, through the company's own active connection; it
-- then keeps its company, invoice and connection. ROT/RUT invoices whose
-- deduction Skatteverket refused are not handed over in this version (the
-- reclaimed share was never printed as the customer's).
CREATE OR REPLACE FUNCTION public.collection_case_invoice_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_invoice record;
  v_connection record;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.company_id <> OLD.company_id OR NEW.invoice_id <> OLD.invoice_id OR NEW.connection_id <> OLD.connection_id THEN
      RAISE EXCEPTION 'A collection case keeps its company, invoice and connection'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  SELECT i.company_id, i.status, i.document_type, i.credited_invoice_id, i.is_self_billed,
         i.remaining_amount, i.deduction_reclaimed_total
    INTO v_invoice
    FROM public.invoices i
   WHERE i.id = NEW.invoice_id;
  IF NOT FOUND OR v_invoice.company_id <> NEW.company_id THEN
    RAISE EXCEPTION 'COLLECTION_CASE_INVOICE_INVALID: the invoice does not belong to the company'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_invoice.document_type IS DISTINCT FROM 'invoice'
     OR v_invoice.credited_invoice_id IS NOT NULL
     OR COALESCE(v_invoice.is_self_billed, false) THEN
    RAISE EXCEPTION 'COLLECTION_CASE_INVOICE_INVALID: only the company''s own customer invoices can be handed over'
      USING ERRCODE = 'check_violation';
  END IF;
  IF v_invoice.status NOT IN ('sent', 'overdue', 'partially_paid') OR COALESCE(v_invoice.remaining_amount, 0) <= 0 THEN
    RAISE EXCEPTION 'COLLECTION_CASE_INVOICE_INVALID: the invoice is not issued and owed (status %)', v_invoice.status
      USING ERRCODE = 'check_violation';
  END IF;
  IF COALESCE(v_invoice.deduction_reclaimed_total, 0) <> 0 THEN
    RAISE EXCEPTION 'COLLECTION_CASE_INVOICE_INVALID: a ROT/RUT share refused by Skatteverket is not handed over'
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT cc.company_id, cc.state INTO v_connection
    FROM public.collection_connections cc
   WHERE cc.id = NEW.connection_id;
  IF NOT FOUND OR v_connection.company_id <> NEW.company_id OR v_connection.state <> 'active' THEN
    RAISE EXCEPTION 'COLLECTION_CASE_CONNECTION_INVALID: the company''s connection is not active'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_case_invoice_guard
  BEFORE INSERT OR UPDATE OF company_id, invoice_id, connection_id ON public.collection_cases
  FOR EACH ROW EXECUTE FUNCTION public.collection_case_invoice_guard();

-- =============================================================================
-- 2. collection_case_events (append-only)
-- =============================================================================

CREATE TABLE public.collection_case_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  case_id uuid NOT NULL REFERENCES public.collection_cases(id) ON DELETE RESTRICT,
  occurred_at timestamptz NOT NULL,
  kind text NOT NULL
    CHECK (kind IN ('stage', 'letter', 'sms', 'call', 'payment', 'note', 'decision', 'user_action',
                    'payment_forwarded', 'payment_reverted', 'credit_forwarded', 'possible_payment',
                    'settlement', 'sync_error', 'other')),
  stage_from text,
  stage_to text,
  direction text CHECK (direction IN ('to_debtor', 'from_debtor', 'internal')),
  label text NOT NULL CHECK (length(label) BETWEEN 1 AND 500),
  amount numeric(14,2),
  actor_user_id uuid REFERENCES auth.users(id),
  -- The provider's own event id: one row per provider event, however often
  -- the case is re-read.
  provider_event_ref text CHECK (provider_event_ref IS NULL OR length(provider_event_ref) <= 128),
  -- Allowlisted by Connect; the ledger also strips anything shaped like a
  -- personal identity number before insert.
  raw jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.collection_case_events IS
  'Append-only trail of a collection case: what the provider did and what the company decided. Never holds debtor identity data.';

-- Not partial on purpose: NULLs are distinct in a unique index, so the
-- ledger's own rows (no provider ref) are unaffected, and an INSERT ... ON
-- CONFLICT (case_id, provider_event_ref) DO NOTHING can name it as the
-- arbiter when a case is re-read.
CREATE UNIQUE INDEX collection_case_events_provider_ref
  ON public.collection_case_events (case_id, provider_event_ref);
CREATE INDEX collection_case_events_case ON public.collection_case_events (case_id, occurred_at);
CREATE INDEX collection_case_events_company ON public.collection_case_events (company_id);

ALTER TABLE public.collection_case_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_case_events_select" ON public.collection_case_events
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_case_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_case_events TO service_role;
-- no-grant: anon on public.collection_case_events (company data)

-- Append-only. The one exception is the sandbox teardown: inside
-- cleanup_sandbox_user (flag set, running as its owner) a row of a company
-- that company_settings still marks as a sandbox may go. UPDATE never.
CREATE OR REPLACE FUNCTION public.collection_case_events_immutable()
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
  RAISE EXCEPTION 'collection_case_events is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER collection_case_events_immutable
  BEFORE UPDATE OR DELETE ON public.collection_case_events
  FOR EACH ROW EXECUTE FUNCTION public.collection_case_events_immutable();

-- An event belongs to its case's company.
CREATE OR REPLACE FUNCTION public.collection_case_event_company_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.collection_cases c WHERE c.id = NEW.case_id AND c.company_id = NEW.company_id
  ) THEN
    RAISE EXCEPTION 'A collection case event belongs to its case''s company'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_case_event_company_guard
  BEFORE INSERT ON public.collection_case_events
  FOR EACH ROW EXECUTE FUNCTION public.collection_case_event_company_guard();

-- =============================================================================
-- 3. An invoice under collection is not cancelled
-- =============================================================================
-- Only drafts are makulerade in the app today, and a case needs an issued
-- invoice, so no flow reaches this; the guard keeps it that way for any
-- future path: the provider would keep dunning the customer for an invoice
-- the books no longer hold.

CREATE OR REPLACE FUNCTION public.block_cancel_invoice_with_open_collection_case()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.collection_cases c WHERE c.invoice_id = NEW.id AND c.is_open) THEN
    RAISE EXCEPTION 'COLLECTION_CASE_OPEN: withdraw the open collection case before cancelling the invoice'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER block_cancel_invoice_with_open_collection_case
  BEFORE UPDATE OF status ON public.invoices
  FOR EACH ROW
  WHEN (NEW.status = 'cancelled' AND OLD.status IS DISTINCT FROM 'cancelled')
  EXECUTE FUNCTION public.block_cancel_invoice_with_open_collection_case();

-- =============================================================================
-- 4. Reads: the invoice list, Att göra and the connection guard
-- =============================================================================

-- The invoice list's chips and its "Hos inkasso" view: every open case the
-- provider holds or is being handed. in_collection is the one definition of
-- "Hos inkasso": open and past delivery (invoice_sent); a registered claim the
-- provider has not started yet is collection too.
-- SECURITY INVOKER: a member sees what RLS lets them see.
CREATE OR REPLACE FUNCTION public.collection_open_invoice_ids(p_company_id uuid)
RETURNS TABLE (
  invoice_id uuid,
  case_id uuid,
  stage text,
  decision_kind text,
  in_collection boolean,
  display_name text
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT c.invoice_id,
         c.id,
         c.stage,
         c.decision_kind,
         c.stage <> 'invoice_sent',
         cc.display_name
    FROM public.collection_cases c
    JOIN public.collection_connections cc ON cc.id = c.connection_id
   WHERE c.company_id = p_company_id
     AND c.is_open
     AND c.submission_status IN ('submitted', 'registered')
$$;

REVOKE ALL ON FUNCTION public.collection_open_invoice_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_open_invoice_ids(uuid) TO authenticated, service_role;

-- Cases a person must look at (Att göra "kring inkasso behöver åtgärdas"):
--   submission_failed  the provider refused the handover, the invoice is
--                      still owed and nothing newer was handed over for it.
--                      Done: a new handover, or the invoice is paid or credited.
--   sync_error         an open case whose last read or retry failed.
--                      Done: the next successful read clears sync_error.
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
$$;

REVOKE ALL ON FUNCTION public.collection_attention_case_ids(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_attention_case_ids(uuid) TO authenticated, service_role;

-- Rebuilt from 20261012030100_collection_connections.sql (the latest
-- definition): open cases now count. A case being prepared has not reached
-- the provider, so it does not hold the connection; one submitted or
-- registered does. Collected payments and settlements stay zero until their
-- tables exist.
CREATE OR REPLACE FUNCTION public.collection_obligation_counts(p_company_id uuid)
RETURNS TABLE (open_cases integer, unbooked_collected_payments integer, unbooked_settlements integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT (SELECT count(*)::integer FROM public.collection_cases c
           WHERE c.company_id = p_company_id
             AND c.is_open
             AND c.submission_status IN ('submitted', 'registered')),
         0,
         0
$$;

REVOKE ALL ON FUNCTION public.collection_obligation_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_obligation_counts(uuid) TO authenticated, service_role;

-- =============================================================================
-- 5. cleanup_sandbox_user: the cases and their trail
-- =============================================================================
-- Rebuilt from 20261012030100_collection_connections.sql (the latest
-- definition). The only change: the case trail and the cases are deleted
-- before the pending operations, the invoices and the connections.

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
