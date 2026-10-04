-- Collections connection: one row per company that activates reminders, debt
-- collection and delivery through a provider in Accounted Connect, its
-- append-only event trail, and the installation's sync cursor.
-- pg-test: tests/pg/collection-connections.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts
--
-- Provider-neutral by design: the provider's name, terms and fees reach the
-- app from the Connect catalogue at runtime. The row stores the catalogue's
-- name at activation (display_name) only as the fallback for when the
-- catalogue cannot be read, and the provider's opaque connection handle,
-- which Connect keeps only as a hash.
--
-- States follow the connection layer (connecting, needs_setup, active,
-- disconnected) with the provider's detail as sub_status. A row is created
-- when an admin has read the terms and consented, before anything about the
-- company leaves the app; a new activation after an ended one is a new row,
-- so the consent trail of the old one stays as it was.
--
-- Writes go through the service role from admin-only routes and the sync
-- cron; members read their company's rows through RLS. Who made the latest
-- change is user_id (NULL when the system wrote it), which is what the audit
-- trigger attributes the change to.
--
-- Obligations: the connection cannot be ended while the company has open
-- cases, unbooked collected payments or unbooked settlements. Those tables
-- come with later migrations, so collection_obligation_counts() answers zero
-- here and each later migration that adds one of them replaces it (rebuild
-- from the latest definition). The trigger and the app read the same
-- function, so they cannot disagree.

-- =============================================================================
-- 1. collection_connections
-- =============================================================================

CREATE TABLE public.collection_connections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The person behind the latest write; NULL when the system wrote it (the
  -- status poll). The audit trigger attributes audited changes to it.
  user_id uuid REFERENCES auth.users(id),

  capability text NOT NULL DEFAULT 'collections' CHECK (capability = 'collections'),
  -- Which adapter serves the row, set once at creation: 'fake' for sandbox
  -- companies and local development, 'connect' otherwise.
  route text NOT NULL CHECK (route IN ('connect', 'fake')),

  provider_ref text NOT NULL CHECK (length(btrim(provider_ref)) BETWEEN 1 AND 64),
  display_name text NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  connection_handle text CHECK (connection_handle IS NULL OR length(connection_handle) BETWEEN 1 AND 256),
  provider_status text,
  -- The provider's terms as its last answer showed them: {version, url, accepted}.
  provider_terms jsonb,

  state text NOT NULL DEFAULT 'connecting'
    CHECK (state IN ('connecting', 'needs_setup', 'active', 'disconnected')),
  sub_status text
    CHECK (sub_status IN ('not_started', 'awaiting_terms', 'awaiting_signature', 'awaiting_kyc', 'in_review', 'rejected', 'disabled')),

  -- Run record and health.
  health text CHECK (health IN ('ok', 'degraded', 'action_required')),
  health_cause text,
  health_action text,
  last_success_at timestamptz,
  last_error_code text,
  last_error_at timestamptz,
  failures_in_row integer NOT NULL DEFAULT 0 CHECK (failures_in_row >= 0),

  -- Consent, given in the app before any company data leaves it.
  catalogue_terms_version text NOT NULL CHECK (length(btrim(catalogue_terms_version)) BETWEEN 1 AND 64),
  dpa_version text,
  consented_by uuid NOT NULL REFERENCES auth.users(id),
  consented_at timestamptz NOT NULL,
  -- The provider's terms as accepted for the company.
  terms_version text,
  terms_accepted_by uuid REFERENCES auth.users(id),
  terms_accepted_at timestamptz,

  -- Lifecycle.
  submitted_at timestamptz,
  activated_at timestamptz,
  ended_by uuid REFERENCES auth.users(id),
  ended_at timestamptz,

  -- Rules for handing invoices over.
  minimum_amount numeric(14,2) NOT NULL DEFAULT 100 CHECK (minimum_amount >= 0),
  default_start_step text NOT NULL DEFAULT 'reminder' CHECK (default_start_step IN ('reminder', 'collection')),
  -- NULL: no reminder fee agreed. Otherwise the date from which the company's
  -- terms state one (Lag 1981:739 2 §: agreed no later than when the debt arose).
  reminder_fee_terms_since date,
  -- Agreed late interest above the statute, and since when (räntelagen 1 §).
  late_interest_percent numeric(5,2) CHECK (late_interest_percent > 0 AND late_interest_percent <= 100),
  late_interest_agreed_since date,
  distribution_enabled boolean NOT NULL DEFAULT false,
  -- NULL until the admin has chosen; activation cannot be submitted without it.
  ladder_mode text CHECK (ladder_mode IN ('off', 'staged')),
  ladder_days_after_due smallint NOT NULL DEFAULT 10 CHECK (ladder_days_after_due BETWEEN 1 AND 60),
  ladder_enabled_by uuid REFERENCES auth.users(id),
  ladder_enabled_at timestamptz,

  -- Posting rules used when collected payments and settlements are booked.
  clearing_account text NOT NULL DEFAULT '1689' CHECK (clearing_account ~ '^[0-9]{4}$'),
  payout_account text NOT NULL DEFAULT '1930' CHECK (payout_account ~ '^[0-9]{4}$'),
  auto_book_collected_payments boolean NOT NULL DEFAULT false,
  auto_book_settlements boolean NOT NULL DEFAULT false,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT collection_connections_late_interest_pair
    CHECK ((late_interest_percent IS NULL) = (late_interest_agreed_since IS NULL)),
  CONSTRAINT collection_connections_ladder_enabled_by
    CHECK (ladder_mode IS DISTINCT FROM 'staged' OR (ladder_enabled_by IS NOT NULL AND ladder_enabled_at IS NOT NULL)),
  -- The provider's detail belongs to the states that have one.
  CONSTRAINT collection_connections_sub_status_shape
    CHECK (state NOT IN ('active', 'disconnected') OR sub_status IS NULL),
  CONSTRAINT collection_connections_ended_shape
    CHECK ((state = 'disconnected') = (ended_at IS NOT NULL)),
  CONSTRAINT collection_connections_terms_shape
    CHECK ((terms_version IS NULL) = (terms_accepted_at IS NULL))
);

COMMENT ON TABLE public.collection_connections IS
  'One live row per company: the collections connection through Accounted Connect. Provider-neutral; the provider''s name comes from the Connect catalogue.';
COMMENT ON COLUMN public.collection_connections.user_id IS
  'The person behind the latest write; NULL when the system wrote it. The audit trigger attributes audited changes to it.';
COMMENT ON COLUMN public.collection_connections.connection_handle IS
  'The provider''s opaque handle for the company, sent as X-Connector-Connection. The only clear copy: Connect stores a hash.';

-- One live connection per company; ended rows stay as the record.
CREATE UNIQUE INDEX collection_connections_one_live
  ON public.collection_connections (company_id)
  WHERE state <> 'disconnected';
CREATE INDEX collection_connections_company ON public.collection_connections (company_id, created_at DESC);
-- The sync cron polls the rows whose activation is under way.
CREATE INDEX collection_connections_connecting
  ON public.collection_connections (updated_at)
  WHERE state = 'connecting';

ALTER TABLE public.collection_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_connections_select" ON public.collection_connections
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_connections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_connections TO service_role;
-- no-grant: anon on public.collection_connections (company data)

CREATE TRIGGER collection_connections_updated_at
  BEFORE UPDATE ON public.collection_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. collection_connection_events (append-only)
-- =============================================================================

CREATE TABLE public.collection_connection_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES public.collection_connections(id) ON DELETE CASCADE,
  from_state text,
  to_state text NOT NULL,
  sub_status text,
  health text,
  reason text,
  actor_user_id uuid REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.collection_connection_events IS
  'Append-only trail of a collections connection: one row per change of state, sub_status or health, written by trigger in the same transaction.';

CREATE INDEX collection_connection_events_connection
  ON public.collection_connection_events (connection_id, created_at);
CREATE INDEX collection_connection_events_company
  ON public.collection_connection_events (company_id);

ALTER TABLE public.collection_connection_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "collection_connection_events_select" ON public.collection_connection_events
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.collection_connection_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_connection_events TO service_role;
-- no-grant: anon on public.collection_connection_events (company data)

-- Append-only. The one exception is the sandbox teardown: inside
-- cleanup_sandbox_user (flag set, running as its owner) a row of a company
-- that company_settings still marks as a sandbox may go. UPDATE never.
CREATE OR REPLACE FUNCTION public.collection_connection_events_immutable()
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
  RAISE EXCEPTION 'collection_connection_events is append-only: rows cannot be changed or deleted'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER collection_connection_events_immutable
  BEFORE UPDATE OR DELETE ON public.collection_connection_events
  FOR EACH ROW EXECUTE FUNCTION public.collection_connection_events_immutable();

-- =============================================================================
-- 3. Obligations and the lifecycle guard
-- =============================================================================

-- Work the company owes or is owed at the provider. Zero until the tables
-- that hold it exist: the migrations that add collection_cases and the
-- settlement tables replace this function. SECURITY INVOKER, so a member's
-- read counts only what RLS lets them see.
CREATE OR REPLACE FUNCTION public.collection_obligation_counts(p_company_id uuid)
RETURNS TABLE (open_cases integer, unbooked_collected_payments integer, unbooked_settlements integer)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT 0, 0, 0
$$;

REVOKE ALL ON FUNCTION public.collection_obligation_counts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.collection_obligation_counts(uuid) TO authenticated, service_role;

-- An ended connection stays ended (a new activation is a new row), and a
-- connection cannot end while work is open at the provider: the provider
-- would keep dunning a customer whose payments nobody reports any more.
CREATE OR REPLACE FUNCTION public.guard_collection_connection_lifecycle()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_open integer;
  v_payments integer;
  v_settlements integer;
BEGIN
  IF OLD.state = 'disconnected' AND NEW.state <> 'disconnected' THEN
    RAISE EXCEPTION 'An ended collections connection cannot be reopened; start a new activation'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id <> OLD.company_id OR NEW.route <> OLD.route THEN
    RAISE EXCEPTION 'A collections connection keeps its company and route'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.state = 'disconnected' AND OLD.state <> 'disconnected' THEN
    SELECT o.open_cases, o.unbooked_collected_payments, o.unbooked_settlements
      INTO v_open, v_payments, v_settlements
      FROM public.collection_obligation_counts(NEW.company_id) o;
    IF COALESCE(v_open, 0) + COALESCE(v_payments, 0) + COALESCE(v_settlements, 0) > 0 THEN
      RAISE EXCEPTION 'COLLECTIONS_DISCONNECT_BLOCKED: % open cases, % unbooked collected payments, % unbooked settlements',
        v_open, v_payments, v_settlements
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER collection_connections_lifecycle
  BEFORE UPDATE ON public.collection_connections
  FOR EACH ROW EXECUTE FUNCTION public.guard_collection_connection_lifecycle();

-- One event row per change of state, sub_status or health, in the same
-- transaction as the change. SECURITY DEFINER: the event table has no
-- INSERT grant for authenticated, and the trail must not depend on who wrote.
CREATE OR REPLACE FUNCTION public.record_collection_connection_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.state IS NOT DISTINCT FROM OLD.state
     AND NEW.sub_status IS NOT DISTINCT FROM OLD.sub_status
     AND NEW.health IS NOT DISTINCT FROM OLD.health THEN
    RETURN NEW;
  END IF;
  INSERT INTO public.collection_connection_events
    (company_id, connection_id, from_state, to_state, sub_status, health, reason, actor_user_id)
  VALUES (
    NEW.company_id,
    NEW.id,
    CASE WHEN TG_OP = 'UPDATE' THEN OLD.state END,
    NEW.state,
    NEW.sub_status,
    NEW.health,
    CASE WHEN NEW.health IN ('degraded', 'action_required') THEN NEW.health_cause END,
    NEW.user_id
  );
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.record_collection_connection_event() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER collection_connections_record_event
  AFTER INSERT OR UPDATE ON public.collection_connections
  FOR EACH ROW EXECUTE FUNCTION public.record_collection_connection_event();

-- Behandlingshistorik (BFL 5 kap. 11 §, BFNAR 2013:2 p. 9.16 st 2): the
-- connection carries rules the system applies on its own (the accounts
-- collected payments and payouts are booked to, automatic booking, the fee
-- and interest the provider may claim, what is handed over), and its
-- lifecycle decides whether any of that runs. The status poll's churn
-- (provider status, health, run record) is left to the event trail.
--
-- Its own audit function instead of write_audit_log: that one falls back to
-- OLD.user_id when NEW.user_id is NULL, which would attribute an activation
-- the status poll saw to whoever last changed a setting. Here the row's
-- user_id is the actor of THIS write, and NULL means the system. Same
-- audit_log shape, same teardown skip.
CREATE OR REPLACE FUNCTION public.audit_collection_connection()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_actor uuid;
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    RETURN NULL;
  END IF;
  v_actor := CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE NEW.user_id END;
  INSERT INTO public.audit_log
    (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_actor,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.company_id ELSE NEW.company_id END,
    TG_OP,
    TG_TABLE_NAME,
    CASE WHEN TG_OP = 'DELETE' THEN OLD.id ELSE NEW.id END,
    v_actor,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END,
    CASE TG_OP WHEN 'INSERT' THEN 'Created' WHEN 'UPDATE' THEN 'Updated' ELSE 'Deleted' END
      || ' ' || TG_TABLE_NAME || ' record',
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), CASE WHEN v_actor IS NULL THEN 'system' ELSE 'user' END),
    nullif(current_setting('gnubok.actor_label', true), '')
  );
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.audit_collection_connection() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER audit_collection_connections
  AFTER INSERT OR DELETE ON public.collection_connections
  FOR EACH ROW EXECUTE FUNCTION public.audit_collection_connection();

CREATE TRIGGER audit_collection_connections_rules
  AFTER UPDATE ON public.collection_connections
  FOR EACH ROW
  WHEN (
    OLD.state IS DISTINCT FROM NEW.state
    OR OLD.terms_version IS DISTINCT FROM NEW.terms_version
    OR OLD.minimum_amount IS DISTINCT FROM NEW.minimum_amount
    OR OLD.default_start_step IS DISTINCT FROM NEW.default_start_step
    OR OLD.reminder_fee_terms_since IS DISTINCT FROM NEW.reminder_fee_terms_since
    OR OLD.late_interest_percent IS DISTINCT FROM NEW.late_interest_percent
    OR OLD.late_interest_agreed_since IS DISTINCT FROM NEW.late_interest_agreed_since
    OR OLD.distribution_enabled IS DISTINCT FROM NEW.distribution_enabled
    OR OLD.ladder_mode IS DISTINCT FROM NEW.ladder_mode
    OR OLD.ladder_days_after_due IS DISTINCT FROM NEW.ladder_days_after_due
    OR OLD.clearing_account IS DISTINCT FROM NEW.clearing_account
    OR OLD.payout_account IS DISTINCT FROM NEW.payout_account
    OR OLD.auto_book_collected_payments IS DISTINCT FROM NEW.auto_book_collected_payments
    OR OLD.auto_book_settlements IS DISTINCT FROM NEW.auto_book_settlements
  )
  EXECUTE FUNCTION public.audit_collection_connection();

-- =============================================================================
-- 4. collection_sync_state (one row per installation)
-- =============================================================================

CREATE TABLE public.collection_sync_state (
  id smallint PRIMARY KEY CHECK (id = 1),
  cursor text,
  last_run_at timestamptz,
  last_error text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.collection_sync_state IS
  'The collections sync cron''s position in the Connect change feed. Installation-wide, service role only.';

ALTER TABLE public.collection_sync_state ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.collection_sync_state TO service_role;
-- no-grant: authenticated on public.collection_sync_state (service-role only: written by the sync cron)
-- no-grant: anon on public.collection_sync_state (service-role only: written by the sync cron)

CREATE TRIGGER collection_sync_state_updated_at
  BEFORE UPDATE ON public.collection_sync_state
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

INSERT INTO public.collection_sync_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- 5. cleanup_sandbox_user: the connection and its trail
-- =============================================================================
-- Rebuilt from 20260927220000_sandbox_teardown_ordered_deletes.sql (the
-- latest definition). The only change: the event trail (append-only, with a
-- teardown window that re-verifies through company_settings) and the
-- connections are deleted before audit_log and the companies. Later
-- collections tables that point at a connection with RESTRICT go before
-- these two.

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

  -- Collections connections (20261004051856): the event trail is append-only
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
