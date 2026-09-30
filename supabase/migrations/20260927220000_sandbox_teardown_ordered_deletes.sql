-- Sandbox teardown: delete children before their parents, never outside the
-- sandbox, and never let a failing sandbox stall the queue (#2837).
-- pg-test: tests/pg/sandbox-cleanup.pg.test.ts, tests/pg/sandbox-teardown-coverage.pg.test.ts
--
-- Prod, 2026-09-27: 1071 sandbox users are past their 24 hour lifetime, the
-- oldest from 2026-09-08. Since 2026-09-23 the nightly cron has cleaned none
-- of them. The Postgres log for the cron shows ten users failing every night:
--
--   6  account_reconciliations_signed_by_fkey (RESTRICT into auth.users)
--   2  transactions_document_id_fkey (RESTRICT into document_attachments)
--   1  journal_entry_rattelse_log_immutable (WORM trigger, no teardown window)
--   1  pending_operations_no_delete: a committed create_voucher operation in
--      a company that is NOT a sandbox
--
-- and cleanup_expired_sandbox_users always picks the oldest p_limit users, so
-- once ten failing users sat at the head of the queue every batch was all
-- failures and the route stopped after its first batch. Before 2026-09-01 the
-- same log shows the supplier_payment_batch_items, webhook_deliveries,
-- audit_log and fiscal_periods blockers that 20260901120000 fixed. The issue's
-- own case (posted depreciation, a disposal) has not happened on prod yet.
--
-- Mechanism, not symptom: the teardown relied on the auth.users cascade for
-- most tenant rows. A RESTRICT or NO ACTION foreign key is checked when the
-- parent row goes, and inside one cascading statement the order in which
-- sibling cascades run is the order of the RI trigger names, which is an
-- accident of creation order (and differs between prod and a fresh CI
-- database once trigger oids cross a digit boundary). Every new register
-- with a RESTRICT foreign key therefore broke the teardown again, as did
-- every new WORM guard without the teardown window.
--
-- This migration:
--
--   1. cleanup_sandbox_user refuses a user who belongs to, created, or wrote
--      journal entries or documents in a company outside their sandbox set.
--      The final auth.users delete cascades into every company the user
--      created (companies_created_by_fkey) and into every row they authored
--      through user_id foreign keys, with gnubok.allow_delete set and the
--      audit trigger muted. Two anonymous sandbox users on prod own a company
--      that is not a sandbox, one of them with 71 posted vouchers there. The
--      old user_id-scoped statements deleted such a company's posted vouchers
--      inside the teardown transaction (reproduced locally, rolled back); what
--      undid it was an unrelated per-row WORM guard firing later
--      (pending_operations on prod, audit_log in the replay). Every data
--      statement is now scoped to the verified sandbox companies instead.
--   2. Every table that holds a RESTRICT or NO ACTION foreign key into a row
--      the teardown deletes is cleared by an explicit statement that runs
--      before the one that deletes the parent, and the companies are deleted
--      explicitly before the account. That makes the order independent of
--      trigger names. tests/pg/sandbox-teardown-coverage.pg.test.ts derives
--      the edges from the catalog and the statement order from this body, and
--      fails when a new foreign key lands without teardown coverage.
--   3. Six WORM delete guards on tables a sandbox reaches gain the teardown
--      window the other guarded tables already have (flag set only by this
--      function, re-verified per row against company_settings.is_sandbox, so
--      a real company is never reachable through it):
--      journal_entry_rattelse_log_immutable, account_reconciliation_attachments_no_delete,
--      block_booked_mileage_trip_deletion, company_facts_guard,
--      guard_fiscal_period_tax_adjustment (DELETE only) and
--      block_annual_report_version_deletion. UPDATE stays forbidden on all.
--   4. cleanup_expired_sandbox_users takes p_offset and reports next_offset:
--      a user whose teardown fails stays at the head of the created_at order,
--      so the next batch starts after it instead of retrying it. The route
--      passes the offset back only when the function returns next_offset, so
--      either deploy order keeps working.
--
-- Deliberately NOT deleted: retention records of an exchange with a party
-- outside Accounted (peppol_deliveries, peppol_delivery_events,
-- peppol_delivery_evidence, peppol_inbound_documents,
-- skatteverket_api_audit_log, arsredovisning_submissions) and
-- company_migration_resets. A sandbox holding one is refused and reported,
-- not silently erased. The coverage test lists each with its reason.
--
-- The rattelse log's RAISE loses its em dash (repo rule) for a colon, as
-- 20260901120000 did for the opening-balance message. The only assertion on
-- the text matches /oföränderlig/ (src/lib/import/__tests__/sie-import-atomic.pg.test.ts)
-- and no runtime code maps it.

-- =============================================================================
-- 1. Teardown windows on six WORM delete guards
-- =============================================================================
-- Invoker functions check current_user against the owner of
-- cleanup_sandbox_user, as block_operation_terminal_delete does
-- (20260913200922): the flag is only honoured inside the definer teardown.
-- The two SECURITY DEFINER guards always run as their owner, so for them the
-- per-row company_settings check is what keeps a real company out of reach.

CREATE OR REPLACE FUNCTION public.journal_entry_rattelse_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'journal_entry_rattelse_log är oföränderlig: rader kan inte ändras eller tas bort.';
END;
$$;

CREATE OR REPLACE FUNCTION public.account_reconciliation_attachments_no_delete()
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
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'account_reconciliation_attachments rows are never deleted (BFL 7 kap.); stamp removed_at instead'
    USING ERRCODE = 'integrity_constraint_violation';
END;
$$;

CREATE OR REPLACE FUNCTION public.block_booked_mileage_trip_deletion()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  IF OLD.status = 'booked' THEN
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
       AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
            WHERE cs.company_id = OLD.company_id) IS TRUE THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete a booked mileage trip: it is retained as underlag (BFL). Reverse the verifikat first.'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.company_facts_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
       AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
            WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure)
       AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
            WHERE cs.company_id = OLD.company_id) IS TRUE THEN
      RETURN OLD;
    END IF;
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

CREATE OR REPLACE FUNCTION public.guard_fiscal_period_tax_adjustment()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  adjustment_row public.fiscal_period_tax_adjustments%ROWTYPE;
  period_row public.fiscal_periods%ROWTYPE;
BEGIN
  -- Sandbox teardown removes the adjustments together with the closed
  -- period they belong to; the lock check below would refuse that forever.
  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
          WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure)
     AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
     AND (
       OLD.company_id IS DISTINCT FROM NEW.company_id
       OR OLD.fiscal_period_id IS DISTINCT FROM NEW.fiscal_period_id
     ) THEN
    RAISE EXCEPTION 'Tax adjustment company and fiscal period are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    adjustment_row := OLD;
  ELSE
    adjustment_row := NEW;
  END IF;

  SELECT * INTO period_row
  FROM public.fiscal_periods
  WHERE id = adjustment_row.fiscal_period_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Fiscal period not found for tax adjustment'
      USING ERRCODE = '23503';
  END IF;

  IF period_row.company_id IS DISTINCT FROM adjustment_row.company_id THEN
    RAISE EXCEPTION 'Tax adjustment company does not match fiscal period company'
      USING ERRCODE = '23514';
  END IF;

  IF period_row.is_closed
     OR period_row.locked_at IS NOT NULL
     OR period_row.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Fiscal period is locked for tax adjustments'
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.block_annual_report_version_deletion()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND current_user = (SELECT pg_get_userbyid(p.proowner) FROM pg_proc p
          WHERE p.oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure)
     AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
          WHERE cs.company_id = OLD.company_id) IS TRUE THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Annual report versions are retained as immutable accounting information (id=%)', OLD.id
    USING ERRCODE = 'check_violation';
END;
$$;

-- =============================================================================
-- 2. cleanup_sandbox_user: eligibility, company scope, children first
-- =============================================================================
-- Statement order is the contract. Three rules, pinned by
-- tests/pg/sandbox-teardown-coverage.pg.test.ts:
--   * a row that holds a RESTRICT or NO ACTION reference is deleted (or the
--     reference cleared) by a statement BEFORE the one that deletes the row
--     it points at, including rows that go through a cascade;
--   * a table whose delete guard re-verifies sandbox-ness through
--     company_settings is purged before the companies delete, which is what
--     takes company_settings away;
--   * every statement names v_companies (or the user's own credentials), so
--     nothing outside the verified sandbox is in reach.

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
-- 3. cleanup_expired_sandbox_users: a failing user never blocks the queue
-- =============================================================================
-- Signature grows p_offset, so DROP and CREATE (as 20260807150000 did). The
-- function-local statement_timeout is restated: CREATE resets proconfig.
-- Candidates are one row per user (a user with two sandbox companies used to
-- be attempted twice, the second attempt failing because the first had
-- already removed them), in (oldest sandbox, user_id) order. Every attempted
-- user either disappears or fails and keeps its place, so failures always
-- form the head of the remaining order, and p_offset = failures so far skips
-- exactly them. next_offset hands the route the value for its next call.

DROP FUNCTION IF EXISTS public.cleanup_expired_sandbox_users(int, int);

CREATE FUNCTION public.cleanup_expired_sandbox_users(
  p_max_age_hours int DEFAULT 24,
  p_limit int DEFAULT NULL,
  p_offset int DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
SET statement_timeout TO '290s'
AS $$
DECLARE
  v_user_id uuid;
  v_offset integer := GREATEST(COALESCE(p_offset, 0), 0);
  v_attempted integer := 0;
  v_cleaned integer := 0;
  v_sandbox_failed integer := 0;
  v_failed integer := 0;
  v_orphans integer := 0;
BEGIN
  FOR v_user_id IN
    SELECT cs.user_id
    FROM public.company_settings cs
    WHERE cs.is_sandbox = true
    GROUP BY cs.user_id
    HAVING min(cs.created_at) < now() - interval '1 hour' * p_max_age_hours
    ORDER BY min(cs.created_at), cs.user_id
    OFFSET v_offset
    LIMIT p_limit
  LOOP
    v_attempted := v_attempted + 1;
    BEGIN
      PERFORM public.cleanup_sandbox_user(v_user_id);
      v_cleaned := v_cleaned + 1;
    EXCEPTION WHEN OTHERS THEN
      v_sandbox_failed := v_sandbox_failed + 1;
      RAISE WARNING 'Failed to clean up sandbox user %: %', v_user_id, SQLERRM;
    END;
  END LOOP;
  v_failed := v_sandbox_failed;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
      AND column_name = 'is_anonymous'
  ) THEN
    FOR v_user_id IN
      SELECT u.id
      FROM auth.users u
      WHERE u.is_anonymous = true
        AND u.created_at < now() - interval '1 hour' * p_max_age_hours
        AND NOT EXISTS (
          SELECT 1 FROM public.company_settings cs WHERE cs.user_id = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.companies c WHERE c.created_by = u.id
        )
        AND NOT EXISTS (
          SELECT 1 FROM public.company_members cm WHERE cm.user_id = u.id
        )
      ORDER BY u.created_at
      LIMIT p_limit
    LOOP
      BEGIN
        DELETE FROM auth.users WHERE id = v_user_id;
        v_orphans := v_orphans + 1;
      EXCEPTION WHEN OTHERS THEN
        v_failed := v_failed + 1;
        RAISE WARNING 'Failed to clean up orphaned anonymous user %: %', v_user_id, SQLERRM;
      END;
    END LOOP;
  END IF;

  RETURN jsonb_build_object(
    'cleaned', v_cleaned,
    'failed', v_failed,
    'orphans_removed', v_orphans,
    'attempted', v_attempted,
    'next_offset', v_offset + v_sandbox_failed
  );
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_expired_sandbox_users(int, int, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_expired_sandbox_users(int, int, int) TO service_role;

NOTIFY pgrst, 'reload schema';
