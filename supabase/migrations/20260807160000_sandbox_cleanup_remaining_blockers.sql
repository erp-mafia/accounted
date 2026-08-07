-- Last two NO ACTION FK blockers in sandbox teardown, found by draining the
-- prod backlog: processing_history.company_id and
-- invoice_deliveries.company_id reference companies without a cascade, so a
-- sandbox whose visitor exercised AI processing or invoice sending cannot be
-- deleted (7 of ~510 backlog users). A data-driven sweep of every NO ACTION
-- FK into companies confirms these two plus the already-handled audit_log
-- are the only tables with rows for stale sandboxes.
--
-- Body otherwise identical to 20260807130000's cleanup_sandbox_user.

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  -- Verify this is a sandbox user: at least one settings row, and EVERY
  -- settings row flagged sandbox. A single-row read would pick an arbitrary
  -- row for a hypothetical multi-company user and the user-scoped deletes
  -- below would then reach the real company's rows.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  -- Sanctioned trigger bypasses, transaction-local and only reachable after
  -- the is_sandbox check above, so real companies can never enter this path.
  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- Clear RESTRICT FKs on document_attachments
  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  -- salary_runs references its booked vouchers with plain NO ACTION FKs.
  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE user_id = p_user_id;

  -- Delete journal entry lines (child of journal_entries)
  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  -- Delete supplier invoices before suppliers cascade
  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  -- Guarded tables that must go while company_settings still exists (their
  -- delete-protect triggers re-verify sandbox-ness through it).
  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Plain NO ACTION company FKs with no cascade: telemetry and delivery
  -- logs the sandbox demo can produce.
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

  -- Purge the sandbox company's audit rows while company_settings still
  -- exists (audit_log_immutable re-verifies sandbox-ness through it).
  DELETE FROM public.audit_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Delete from auth.users cascades everything else
  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Drop the bypasses before returning so nothing later in the same
  -- transaction runs with them still armed.
  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;
