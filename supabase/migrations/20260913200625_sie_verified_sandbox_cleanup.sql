-- SIE retention applies to real-company history. The existing service-only
-- sandbox teardown may delete disposable demo history after rechecking the
-- exact company's immutable classification, never on the cleanup flag alone.
-- Only DELETE receives this exception; journal enforcement stays unchanged.
-- pg-test: covered-by tests/pg/sie-sandbox-cleanup.pg.test.ts

CREATE OR REPLACE FUNCTION public.guard_sie_execution_metadata() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
      AND current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
        WHERE oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure)
      AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
        WHERE cs.company_id = OLD.company_id) IS TRUE THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SIE execution history cannot be deleted' USING ERRCODE = '23514';
  END IF;
  IF current_user IN ('anon','authenticated','service_role')
     AND (NEW.job_state IS NOT NULL OR (TG_OP = 'UPDATE' AND OLD.job_state IS NOT NULL)) THEN
    RAISE EXCEPTION 'SIE execution metadata requires an authorized RPC' USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.job_state IN ('completed','undone')
     AND NEW.manifest IS DISTINCT FROM OLD.manifest THEN
    RAISE EXCEPTION 'SIE execution manifest is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.retain_sie_batch_entry() RETURNS trigger LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF OLD.import_batch_id IS NOT NULL THEN
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
      AND current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
        WHERE oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure)
      AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
        WHERE cs.company_id = OLD.company_id) IS TRUE THEN RETURN OLD; END IF;
    RAISE EXCEPTION 'SIE batch entries cannot be deleted; use batch storno' USING ERRCODE = '55000';
  END IF;
  RETURN OLD;
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_sie_repair_item() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
      AND current_user = (SELECT pg_get_userbyid(proowner) FROM pg_proc
        WHERE oid = 'public.cleanup_sandbox_user(uuid)'::regprocedure)
      AND (SELECT bool_and(cs.is_sandbox IS TRUE) FROM public.company_settings cs
        WHERE cs.company_id = OLD.company_id) IS TRUE THEN RETURN OLD; END IF;
  IF TG_OP='DELETE' OR current_user IN ('anon','authenticated','service_role') THEN
    RAISE EXCEPTION 'SIE repair scope is immutable' USING ERRCODE='42501';
  END IF;
  IF TG_OP='UPDATE' AND ((to_jsonb(NEW)-'reversal_id'-'cancelled_at'-'updated_at') IS DISTINCT FROM
    (to_jsonb(OLD)-'reversal_id'-'cancelled_at'-'updated_at') OR OLD.reversal_id IS NOT NULL OR OLD.cancelled_at IS NOT NULL) THEN
    RAISE EXCEPTION 'SIE repair receipt is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

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

  -- Remove SIE-only blockers while the immutable company classification
  -- remains available to each retention guard. Clearing the hold separately
  -- allows the ordinary sandbox teardown to clear IB and closing pointers.
  DELETE FROM public.sie_duplicate_repair_items WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_import_chunks WHERE company_id = ANY(v_companies);
  DELETE FROM public.sie_period_read_leases WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET import_hold = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.fiscal_periods SET opening_balance_review_import_id = NULL,
    opening_balance_review_token = NULL, opening_balance_review_entry_id = NULL,
    opening_balance_review_reason = NULL WHERE company_id = ANY(v_companies);
  UPDATE public.sie_imports SET opening_balance_entry_id = NULL WHERE company_id = ANY(v_companies);

  -- API keys must die with the sandbox, and api_keys.sod_acknowledged_by
  -- (NO ACTION to auth.users) otherwise blocks the auth delete.
  DELETE FROM public.api_keys WHERE user_id = p_user_id;

  -- WORM retag log: delete under the bypass while company_settings still
  -- exists, and before the journal deletes whose cascade would otherwise
  -- reach it.
  DELETE FROM public.dimension_retag_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Match log: append-only, user-scoped on purpose, and purged this early for
  -- two reasons. lib/invoices/match-log.ts writes rows with no company_id, and
  -- the guard can only recognise those as sandbox rows while the
  -- company_settings row still exists, which the auth.users cascade cannot
  -- promise (company_settings.user_id cascades from the same delete, and
  -- sibling cascade order is undefined). And payment_match_log.supplier_invoice_id
  -- is ON DELETE SET NULL, so the supplier_invoices delete further down turns
  -- into an UPDATE on any row that references one, which the guard still
  -- refuses even during teardown.
  DELETE FROM public.payment_match_log
  WHERE user_id = p_user_id
     OR company_id IN (
       SELECT cs.company_id FROM public.company_settings cs
       WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
     );

  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE user_id = p_user_id;

  -- fiscal_periods points at its IB and bokslut vouchers with plain NO ACTION
  -- FKs, and previous_period_id chains periods to each other the same way.
  -- Clearing all three under the teardown bypass is what lets the journal
  -- delete below run at all.
  UPDATE public.fiscal_periods
  SET opening_balance_entry_id = NULL,
      closing_entry_id = NULL,
      previous_period_id = NULL
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  -- Betalfil batches: their items reference supplier_invoices with
  -- ON DELETE RESTRICT, so the batch headers must go first (the items
  -- cascade off the header, and neither table has a delete guard).
  DELETE FROM public.supplier_payment_batches
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Journal references are gone. Delete import rows explicitly instead of
  -- relying on the auth-user cascade, whose settings-delete order is unknown.
  DELETE FROM public.sie_imports WHERE company_id = ANY(v_companies);

  DELETE FROM public.processing_history
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.invoice_deliveries
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Terminal webhook deliveries: guarded against DELETE, and reached by the
  -- auth.users -> companies cascade unless purged here under the bypass.
  DELETE FROM public.webhook_deliveries
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.audit_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

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
