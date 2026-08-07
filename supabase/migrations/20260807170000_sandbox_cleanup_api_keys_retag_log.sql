-- Final two sandbox-teardown blockers, from the last 9 users of the prod
-- backlog (every earlier class is fixed by 20260807130000/160000):
--
--   * api_keys.sod_acknowledged_by references auth.users with NO ACTION, so
--     a sandbox whose visitor created an API key and acknowledged the
--     separation-of-duties prompt cannot be deleted (8 users). The key rows
--     must die with the sandbox anyway, so cleanup_sandbox_user deletes them
--     explicitly.
--   * dimension_retag_log is WORM (dimension_retag_log_immutable raises
--     unconditionally), so a sandbox where a voucher line was retagged
--     cannot be deleted (1 user). The trigger's DELETE branch gains the
--     same transaction-local flag plus per-row sandbox re-verification as
--     every other guard in this chain; UPDATE stays blocked.

-- =============================================================================
-- 1. dimension_retag_log_immutable: allow sandbox-teardown DELETE
-- =============================================================================

CREATE OR REPLACE FUNCTION public.dimension_retag_log_immutable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- Sandbox teardown removes the whole demo company; its retag log goes
  -- with it. Transaction-local flag, only set by cleanup_sandbox_user after
  -- its all-rows is_sandbox check, re-verified per row so the flag alone
  -- can never unlock a real company's log. UPDATE stays forbidden.
  IF TG_OP = 'DELETE'
     AND current_setting('gnubok.sandbox_cleanup', true) = 'true'
     AND EXISTS (
       SELECT 1 FROM public.company_settings cs
       WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
     ) THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'dimension_retag_log är oföränderlig — rader kan inte ändras eller tas bort.';
END;
$$;

-- =============================================================================
-- 2. cleanup_sandbox_user: delete api_keys and dimension_retag_log explicitly
-- =============================================================================

-- Body otherwise identical to 20260807160000.

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
  -- settings row flagged sandbox.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

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

  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

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
