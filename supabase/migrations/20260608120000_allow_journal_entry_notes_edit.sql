-- Fix: allow editing the internal `notes` field on a committed journal entry.
--
-- Bug: saving a note on a posted verifikation failed with
-- "Cannot modify a posted journal entry ... Committed entries are immutable".
-- The detail page (app/(dashboard)/bookkeeping/[id]/page.tsx) and the
-- /api/bookkeeping/journal-entries/[id]/notes route treat `notes` as
-- always-editable internal metadata, but enforce_journal_entry_immutability()
-- only permitted draft→{draft,posted,cancelled}, posted→{reversed,cancelled}
-- and the reversed→posted un-reversal. A note edit is a posted→posted UPDATE,
-- which fell through to the final RAISE EXCEPTION.
--
-- Legal basis for the carve-out: `notes` is internal annotation metadata, NOT
-- verifikation content under BFL 5 kap. / BFNAR 2013:2. Adding or editing a
-- note leaves every bookkeeping field untouched — entry_date, description,
-- accounts, amounts (the lines), voucher_series, voucher_number, status,
-- source_* — so it does not alter the bokföringspost. The immutability
-- guarantee for the verifikation itself is fully preserved: this path allows a
-- change to `notes` ONLY, verified with a whole-row to_jsonb() diff. Any other
-- field change on a committed entry still raises.
--
-- Scope notes:
--   * Period lock is unchanged. enforce_period_lock fires after this trigger
--     and still blocks notes edits on entries in a closed/locked period. Notes
--     are editable on committed entries in OPEN periods only — the reported
--     case (entry 9b97..., posted, period open).
--   * This is a CREATE OR REPLACE in a NEW migration, the same pattern used by
--     20260428160000_fix_journal_entry_immutability_delete_bypass.sql. The
--     legally-required protections in migration 017 are extended, never weakened.
--   * Restores `SET search_path = public`, which the 20260428160000
--     CREATE OR REPLACE silently dropped (the security pin added by
--     20260304191528_set_search_path_on_functions.sql).

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

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$function$;
