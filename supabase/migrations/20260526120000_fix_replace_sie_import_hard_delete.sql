-- Rewrite replace_sie_import to hard-delete the prior import's entries
-- instead of soft-cancelling them.
--
-- The previous implementation (20260415000000_schema_sync.sql) only set
-- status='cancelled' on the affected journal_entries. Cancelled rows kept
-- their voucher_numbers in the partial unique index
-- uq_journal_entries_voucher_number, and voucher_sequences.last_number was
-- never reset, so each successive re-import had to claim a fresh, higher
-- range (A27, A28...) and any document the user had attached was left
-- pinned to a now-invisible cancelled entry.
--
-- The new behaviour mirrors the manual cleanup we use for stuck tenants:
-- 1. detach documents (PDFs stay in storage, become unlinked)
-- 2. clear fiscal_periods.opening_balance_entry_id if it pointed to this
--    import's OB entry (two-step around enforce_opening_balance_immutability)
-- 3. clear sie_imports.opening_balance_entry_id on the replaced row
-- 4. hard-delete all source_type='import' entries (posted OR previously
--    cancelled) in the period; lines cascade
-- 5. reset voucher_sequences.last_number per series to MAX(remaining
--    voucher_number) or 0 -- handles interleaved manual/bank_transaction
--    entries safely
-- 6. mark sie_imports status='replaced', replaced_at=now()
--
-- Audit trail is preserved via:
--   * sie_imports row (status, replaced_at, filename, file_hash,
--     transactions_count, fiscal_year_start/end)
--   * audit_log entries written automatically by the existing
--     write_audit_log trigger on each journal_entries DELETE (old_state
--     JSONB snapshot per row)
--
-- The gnubok.allow_delete='true' GUC is set transaction-local via
-- set_config(..., is_local=true) and is honored by:
--   * enforce_journal_entry_immutability  (allows DELETE)
--   * enforce_journal_entry_line_immutability  (allows cascade DELETE)
--   * enforce_retention_journal_entries  (allows DELETE within 7y window)
--   * enforce_document_journal_entry_immutability  (allows clearing
--     journal_entry_id on document_attachments)
--   * enforce_document_metadata_immutability  (allows metadata change on
--     docs linked to posted entries)
--
-- enforce_opening_balance_immutability does NOT honor the GUC -- worked
-- around by flipping opening_balances_set to false first, then clearing
-- opening_balance_entry_id in a separate UPDATE.

CREATE OR REPLACE FUNCTION public.replace_sie_import(p_company_id uuid, p_import_id uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_fiscal_period_id          uuid;
  v_opening_balance_entry_id  uuid;
  v_is_closed                 boolean;
  v_locked_at                 timestamptz;
  v_deleted                   integer := 0;
BEGIN
  SELECT fiscal_period_id, opening_balance_entry_id
    INTO v_fiscal_period_id, v_opening_balance_entry_id
    FROM public.sie_imports
   WHERE id = p_import_id
     AND company_id = p_company_id
     AND status = 'completed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found or not in completed status', p_import_id;
  END IF;

  IF v_fiscal_period_id IS NOT NULL THEN
    SELECT is_closed, locked_at
      INTO v_is_closed, v_locked_at
      FROM public.fiscal_periods
     WHERE id = v_fiscal_period_id;

    IF v_is_closed OR v_locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot replace SIE import in a locked or closed fiscal period';
    END IF;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  -- Detach any documents the user attached to the import's entries.
  -- Files stay in Supabase storage; the document rows become unlinked
  -- and can be re-attached after the next import. We cover both
  -- entry-level and line-level attachments because both FKs are RESTRICT
  -- and the line variant would otherwise block the cascade delete below.
  UPDATE public.document_attachments
     SET journal_entry_id      = NULL,
         journal_entry_line_id = NULL
   WHERE journal_entry_id IN (
     SELECT je.id
       FROM public.journal_entries je
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       = 'import'
        AND je.status            IN ('posted', 'cancelled')
   )
      OR journal_entry_line_id IN (
     SELECT jel.id
       FROM public.journal_entry_lines jel
       JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       = 'import'
        AND je.status            IN ('posted', 'cancelled')
   );

  -- Clear the fiscal-period OB pointer (if it came from this import).
  -- enforce_opening_balance_immutability blocks the change unless we
  -- flip opening_balances_set to false in a separate statement first --
  -- the trigger only raises when both opening_balances_set was true AND
  -- the id is being changed in the same UPDATE.
  IF v_opening_balance_entry_id IS NOT NULL THEN
    UPDATE public.fiscal_periods
       SET opening_balances_set = false
     WHERE id = v_fiscal_period_id
       AND opening_balance_entry_id = v_opening_balance_entry_id;

    UPDATE public.fiscal_periods
       SET opening_balance_entry_id = NULL
     WHERE id = v_fiscal_period_id
       AND opening_balance_entry_id = v_opening_balance_entry_id;
  END IF;

  -- Drop the sie_imports -> opening_balance_entry FK before we delete the
  -- entry it points to (FK is SET NULL on delete, but explicit clear is
  -- clearer and avoids relying on cascade ordering).
  UPDATE public.sie_imports
     SET opening_balance_entry_id = NULL
   WHERE id = p_import_id;

  -- Hard-delete the import's journal entries. Lines cascade. The
  -- 'cancelled' predicate vacuums stragglers from any prior soft-replace
  -- so re-fixing a doubly-replaced period also cleans up the residue.
  WITH deleted AS (
    DELETE FROM public.journal_entries
     WHERE company_id        = p_company_id
       AND fiscal_period_id  = v_fiscal_period_id
       AND source_type       = 'import'
       AND status            IN ('posted', 'cancelled')
    RETURNING id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  -- Reset voucher_sequences for the period. For each series, set
  -- last_number to the max remaining voucher_number (or 0 if none) so
  -- the next next_voucher_number() call yields the right number whether
  -- the user re-imports straight away (starts at 1) or interleaved
  -- manual entries already occupy higher numbers in the series.
  UPDATE public.voucher_sequences vs
     SET last_number = COALESCE((
           SELECT MAX(je.voucher_number)
             FROM public.journal_entries je
            WHERE je.company_id       = vs.company_id
              AND je.fiscal_period_id = vs.fiscal_period_id
              AND je.voucher_series   = vs.voucher_series
              AND je.voucher_number  > 0
         ), 0),
         updated_at = now()
   WHERE vs.company_id        = p_company_id
     AND vs.fiscal_period_id  = v_fiscal_period_id;

  UPDATE public.sie_imports
     SET status      = 'replaced',
         replaced_at = now()
   WHERE id = p_import_id
     AND company_id = p_company_id;

  RETURN v_deleted;
END;
$function$;

NOTIFY pgrst, 'reload schema';
