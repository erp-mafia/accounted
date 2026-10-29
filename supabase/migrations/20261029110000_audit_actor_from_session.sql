-- Behandlingshistorik names the person who made a change, not the person who
-- created the row (issue #126).
--
-- Why it was wrong
--
-- write_audit_log() and write_sie_header_audit() (its copy on journal_entries
-- since 20260911143237) take audit_log.user_id and actor_id from the audited
-- row's own user_id column and fall back to auth.uid() only when the row has
-- none. That rule comes from the single-user schema (20240101000018), where
-- the one user who owned a row was the only one who could write it, so the
-- row's user_id was the actor. Since 20260330130000 a company has several
-- members and a row's user_id is who created it: an update or delete by any
-- other member was logged under the creator. company_settings shows it
-- worst: its user_id is whoever first saved the company's settings, so every
-- later change, the lock date (bookkeeping_locked_through) included, named
-- that person whoever made it. The same held for a COMMIT or REVERSE of a
-- colleague's draft or verifikat, a period lock, a change to the chart of
-- accounts.
--
-- What changes
--
-- Both functions take the actor from the session: auth.uid() when the
-- statement runs under a user's JWT, the row's user_id only when there is no
-- session. The session is the person whose request ran the statement, also
-- inside the SECURITY DEFINER RPCs that act for their caller, so preferring
-- it can only replace a creator with the actor. It is the rule
-- commit_journal_entry already applies to event_log and voucher_sequences,
-- and stamp_journal_entry_committed_by to journal_entries.committed_by
-- (20260929220100): coalesce(auth.uid(), user_id).
--
-- What stays
--
--   * A write without a session (the service role) carries no person the
--     database can read, so it keeps the row's user_id, as before; an RPC
--     that sets the gnubok.actor_type / gnubok.actor_label GUCs still names
--     the credential. That covers cron, workers, SIE import chunks and
--     migrations, but also writes made for a person through a service-role
--     client: API keys, MCP, and the invoicer role's scoped client
--     (lib/auth/company-scoped-client.ts). Those still name the row's
--     creator on an update; naming the person there needs the actor carried
--     into the transaction, which this migration does not do.
--   * Everything else in both functions is the newest definition, identical
--     apart from line endings (write_audit_log from 20260807130000,
--     write_sie_header_audit from 20260911143237). CREATE OR REPLACE keeps
--     owners and grants.
--
-- Which audited tables relied on the old order (checked 2026-10-28)
--
-- None of the tables on these two functions needs the row's user_id over
-- the session:
--   * on most of them user_id is the owner or creator (company_settings,
--     fiscal_periods, chart_of_accounts, journal_entries, suppliers,
--     supplier_invoices, mapping_rules, api_keys, ...): the bug.
--   * where user_id is the author (community_feedback, whose RLS requires
--     user_id = auth.uid()), a session write stamps it from the session, so
--     the two agree.
--   * tables without a user_id column (dimensions, journal_entry_lines,
--     booking_template_library, signing_requests, ...) already used
--     auth.uid() and see no change.
-- The tables that keep an actor in user_id on purpose audit through their
-- own functions and are not touched: collection_connections
-- (audit_collection_connection, decision of 2026-10-04), service_accounts,
-- cash_accounts routing, and signing_request_signers (signing_signer_audit:
-- only the service role writes there, so auth.uid() is always NULL and the
-- order cannot matter).
--
-- pg-test: tests/pg/audit-actor-from-session.pg.test.ts

-- =============================================================================
-- 1. write_audit_log: the actor from the session
-- =============================================================================

CREATE OR REPLACE FUNCTION public.write_audit_log()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  -- Sandbox teardown (cleanup_sandbox_user) deletes the company row itself;
  -- audit rows inserted mid-cascade would reference the vanishing company
  -- and violate audit_log_company_id_fkey. The flag is transaction-local and
  -- only set after the RPC's is_sandbox check.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  -- The actor is the session's user. Without a session (the service role)
  -- the row's user_id, its owner or creator, stands in as before (#126).
  v_user_id := COALESCE(auth.uid(), v_user_id);

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

-- =============================================================================
-- 2. write_sie_header_audit (journal_entries): the same change
-- =============================================================================

CREATE OR REPLACE FUNCTION public.write_sie_header_audit()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_user_id    uuid;
  v_company_id uuid;
  v_action     text;
  v_old_state  jsonb;
  v_new_state  jsonb;
  v_record_id  uuid;
  v_desc       text;
BEGIN
  IF TG_OP IN ('INSERT','UPDATE') AND NEW.import_batch_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.sie_imports WHERE id=NEW.import_batch_id AND company_id=NEW.company_id
      AND audit_mode='chunk' AND job_state IN ('running','finalizing') AND job_phase IN ('vouchers','finalize')
  ) THEN RETURN NEW; END IF;
  -- Sandbox teardown (cleanup_sandbox_user) deletes the company row itself;
  -- audit rows inserted mid-cascade would reference the vanishing company
  -- and violate audit_log_company_id_fkey. The flag is transaction-local and
  -- only set after the RPC's is_sandbox check.
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := NULL;
    v_record_id := OLD.id;
    v_user_id := (v_old_state->>'user_id')::uuid;
    v_company_id := (v_old_state->>'company_id')::uuid;
    v_action := 'DELETE';
    v_desc := 'Deleted ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'INSERT' THEN
    v_old_state := NULL;
    v_new_state := to_jsonb(NEW);
    v_record_id := NEW.id;
    v_user_id := (v_new_state->>'user_id')::uuid;
    v_company_id := (v_new_state->>'company_id')::uuid;
    v_action := 'INSERT';
    v_desc := 'Created ' || TG_TABLE_NAME || ' record';
  ELSIF TG_OP = 'UPDATE' THEN
    v_old_state := to_jsonb(OLD);
    v_new_state := to_jsonb(NEW);
    v_record_id := COALESCE(NEW.id, OLD.id);
    v_user_id := COALESCE((v_new_state->>'user_id')::uuid, (v_old_state->>'user_id')::uuid);
    v_company_id := COALESCE((v_new_state->>'company_id')::uuid, (v_old_state->>'company_id')::uuid);
    v_action := 'UPDATE';
    v_desc := 'Updated ' || TG_TABLE_NAME || ' record';

    IF TG_TABLE_NAME = 'journal_entries' THEN
      IF OLD.status = 'draft' AND NEW.status = 'posted' THEN
        v_action := 'COMMIT';
        v_desc := 'Committed journal entry ' || NEW.voucher_series || NEW.voucher_number;
      ELSIF OLD.status = 'posted' AND NEW.status = 'reversed' THEN
        v_action := 'REVERSE';
        v_desc := 'Reversed journal entry ' || OLD.voucher_series || OLD.voucher_number;
      END IF;
    END IF;

    IF TG_TABLE_NAME = 'fiscal_periods' THEN
      IF (OLD.locked_at IS NULL AND NEW.locked_at IS NOT NULL) THEN
        v_action := 'LOCK_PERIOD';
        v_desc := 'Locked fiscal period "' || NEW.name || '"';
      ELSIF (NOT OLD.is_closed AND NEW.is_closed) THEN
        v_action := 'CLOSE_PERIOD';
        v_desc := 'Closed fiscal period "' || NEW.name || '"';
      END IF;
    END IF;
  END IF;

  -- The actor is the session's user. Without a session (the service role)
  -- the row's user_id, its owner or creator, stands in as before (#126).
  v_user_id := COALESCE(auth.uid(), v_user_id);

  INSERT INTO public.audit_log (user_id, company_id, action, table_name, record_id, actor_id, old_state, new_state, description, actor_type, actor_label)
  VALUES (
    v_user_id, v_company_id, v_action, TG_TABLE_NAME, v_record_id, v_user_id, v_old_state, v_new_state, v_desc,
    COALESCE(nullif(current_setting('gnubok.actor_type', true), ''), 'user'),
    nullif(current_setting('gnubok.actor_label', true), '')
  );

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;
