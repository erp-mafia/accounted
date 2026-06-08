-- Re-tag a mis-typed bank-account opening balance (source_type 'manual'/'import')
-- as 'opening_balance' so bank reconciliation excludes it from period movement.
--
-- Bug context: getReconciliationStatus (lib/reconciliation/bank-reconciliation.ts)
-- and the get_unlinked_gl_lines / get_account_gl_lines_for_matching RPCs identify
-- the ingående balans (IB) on a cash account SOLELY by journal_entries.source_type
-- = 'opening_balance'. Companies migrated from another system frequently booked
-- the bank-account IB as an ordinary voucher, so it lands as source_type 'import'
-- (SIE #VER) or 'manual'. Such an IB is never excluded, so it surfaces as a phantom
-- reconciliation difference equal to the opening balance — reported by users as
-- "1940 räknar med IB som en diff" while 1930 (whose IB happened to be typed
-- opening_balance) reconciles cleanly. There is no mid-period opening_balance: a
-- genuine IB always sits on a fiscal-period boundary on a balance-sheet account.
--
-- This migration adds a controlled, audited way to fix such an entry WITHOUT a
-- blanket data sweep:
--   1. A GUC-gated carve-out in enforce_journal_entry_immutability that permits a
--      source_type-only change manual/import -> opening_balance on a posted entry.
--   2. A SECURITY DEFINER RPC mark_entry_as_opening_balance() that validates the
--      entry, sets the bypass flag, performs the UPDATE, and writes an audit row.
--
-- Legal basis for the carve-out (mirrors the `notes` carve-out from
-- 20260608120000_allow_journal_entry_notes_edit.sql): source_type is an INTERNAL
-- classification tag, NOT verifikation content under BFL 5 kap. / BFNAR 2013:2.
-- The re-tag leaves every bookkeeping field untouched — entry_date, description,
-- accounts and amounts (the lines), voucher_series, voucher_number, status,
-- source_id — so it does not alter the bokföringspost. The change is verified with
-- a whole-row to_jsonb() diff: any other field delta still raises. The immutability
-- guarantee for the verifikation itself is fully preserved; migration 017's
-- protections are EXTENDED, never weakened.
--
-- Scope / safety notes:
--   * Period lock is unchanged. The RPC explicitly refuses on a closed/locked
--     period (mirroring delete_last_voucher); enforce_period_lock remains the
--     backstop. IBs in a closed year must have the period reopened first.
--   * opening_balance_entry_id is deliberately NOT repointed here. SIE export keys
--     #IB off that column and does not exclude the OB entry from #VER, so repointing
--     could double-count. We only change source_type.
--   * Downstream effect to be aware of: undo_sie_import hard-deletes source_type
--     IN ('import','opening_balance') in a period. A 'manual' entry re-tagged here
--     therefore becomes deletable by a later Undo SIE Import — acceptable, since a
--     genuine IB belongs with the import-era opening position.

-- =============================================================================
-- 1. Extend enforce_journal_entry_immutability with a source_type retag carve-out
--    (CREATE OR REPLACE — reproduces the current body from
--     20260608120000_allow_journal_entry_notes_edit.sql verbatim, then adds the
--     new GUC-gated branch before the final RAISE).
-- =============================================================================
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- Narrow un-reversal path: when delete_last_voucher removes a storno entry,
  -- it flips the original from 'reversed' back to 'posted'. No other fields
  -- may change, and the bypass flag must be set.
  IF OLD.status = 'reversed' AND NEW.status = 'posted'
     AND current_setting('gnubok.allow_delete', true) = 'true' THEN
    IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
       OR NEW.fiscal_period_id != OLD.fiscal_period_id
       OR NEW.voucher_number != OLD.voucher_number THEN
      RAISE EXCEPTION 'Cannot modify fields during un-reversal (id: %)', OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  -- Notes-only annotation on a committed entry (posted/reversed/cancelled).
  -- `notes` is internal metadata, not verifikation content, so editing it does
  -- not violate immutability. Allowed ONLY when the status is unchanged and the
  -- sole difference between OLD and NEW is `notes` (updated_at is exempt because
  -- the journal_entries_updated_at trigger bumps it). The to_jsonb() diff covers
  -- every other column automatically, so any real bookkeeping change still raises.
  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at')
       = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Source-type re-tag of a mis-typed opening balance. source_type is internal
  -- classification metadata, not verifikation content (see header), so moving a
  -- bank-account IB from manual/import to opening_balance does not alter the
  -- bokföringspost. Allowed ONLY when: the transaction-local bypass flag set by
  -- mark_entry_as_opening_balance() is present; status is unchanged 'posted'; the
  -- value moves manual/import -> opening_balance; and source_type is the SOLE
  -- changed column (whole-row to_jsonb diff, updated_at exempt as above). Any other
  -- field delta, status change, or missing flag still raises below.
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$function$;

-- =============================================================================
-- 2. mark_entry_as_opening_balance() — controlled, audited re-tag RPC
-- =============================================================================
CREATE OR REPLACE FUNCTION public.mark_entry_as_opening_balance(
  p_company_id uuid,
  p_entry_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_caller_role     text;
  v_entry           record;
  v_is_closed       boolean;
  v_locked_at       timestamptz;
  v_has_bank_line   boolean;
  v_old_source_type text;
BEGIN
  -- Owner/admin only (defense in depth alongside RLS; the function is SECURITY
  -- DEFINER so it must enforce tenancy + role itself).
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = auth.uid();

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can re-tag opening balances';
  END IF;

  SELECT * INTO v_entry
  FROM journal_entries
  WHERE id = p_entry_id
    AND company_id = p_company_id
  FOR UPDATE;

  IF v_entry IS NULL THEN
    RAISE EXCEPTION 'Journal entry not found';
  END IF;

  IF v_entry.status <> 'posted' THEN
    RAISE EXCEPTION 'Only posted entries can be re-tagged as opening balance (current status: %)', v_entry.status;
  END IF;

  IF v_entry.source_type NOT IN ('manual', 'import') THEN
    RAISE EXCEPTION 'Only manual/import entries can be re-tagged as opening balance (current source_type: %)', v_entry.source_type;
  END IF;

  -- Must touch a bank/cash account. Re-tagging excludes the WHOLE entry from the
  -- reconciliation period movement, so it must genuinely be a bank-account IB.
  SELECT EXISTS (
    SELECT 1 FROM journal_entry_lines l
    WHERE l.journal_entry_id = p_entry_id
      AND l.account_number IN ('1910','1920','1930','1931','1932','1940','1941','1950')
  ) INTO v_has_bank_line;

  IF NOT v_has_bank_line THEN
    RAISE EXCEPTION 'Entry does not touch a bank/cash account (19xx); refusing to tag as opening balance';
  END IF;

  -- Respect period lock (mirror delete_last_voucher). enforce_period_lock would
  -- block the UPDATE anyway; we refuse first with a clearer message.
  SELECT is_closed, locked_at INTO v_is_closed, v_locked_at
  FROM fiscal_periods
  WHERE id = v_entry.fiscal_period_id;

  IF v_is_closed THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a closed fiscal period';
  END IF;
  IF v_locked_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cannot re-tag an entry in a locked fiscal period';
  END IF;

  v_old_source_type := v_entry.source_type;

  -- Transaction-local bypass consumed by the immutability carve-out above.
  PERFORM set_config('gnubok.allow_source_type_retag', 'true', true);

  UPDATE journal_entries
  SET source_type = 'opening_balance'
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  -- Provenance row (write_audit_log also logs old/new state via the AFTER trigger;
  -- this adds the human-readable reason, matching the delete_last_voucher pattern).
  INSERT INTO audit_log (user_id, company_id, action, table_name, record_id, actor_id, description)
  VALUES (
    v_entry.user_id,
    p_company_id,
    'UPDATE',
    'journal_entries',
    p_entry_id,
    auth.uid(),
    'Re-tagged source_type ' || v_old_source_type || ' -> opening_balance ' ||
    '(mark_entry_as_opening_balance RPC, caller: ' || auth.uid() || ')'
  );

  RETURN jsonb_build_object(
    'retagged', true,
    'entry_id', p_entry_id,
    'previous_source_type', v_old_source_type,
    'voucher_series', v_entry.voucher_series,
    'voucher_number', v_entry.voucher_number
  );
END;
$function$;

-- Company-scoped write RPC: never executable by anon/PUBLIC. Authenticated callers
-- pass the tenancy + role gate inside the function. (Mirrors the gl_lines and
-- bulk_book RPC lockdown pattern.)
REVOKE ALL ON FUNCTION public.mark_entry_as_opening_balance(uuid, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_entry_as_opening_balance(uuid, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
