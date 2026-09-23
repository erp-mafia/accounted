-- Security fix: posted -> cancelled had no field-lock check, unlike posted ->
-- reversed. A company writer could change other fields (description, dates,
-- etc.) in the same statement that cancels a posted entry, with no trace,
-- and the trial balance excludes cancelled entries so it just disappears.
--
-- Fix: lock the cancelled branch with a full-row comparison (excluding
-- status/updated_at), so future columns are covered without a hand-maintained
-- list. Every legitimate posted -> cancelled call site writes status alone
-- (reverseEntry's orphan cleanup, cancelOrphanedPaymentEntry), so nothing
-- legitimate needs the looser rule.
--
-- The reversed branch keeps its enumerated list unchanged: the storno path
-- legitimately writes reversed_by_id in the same statement as the status, so
-- a full-row comparison there would break real reversals.
CREATE OR REPLACE FUNCTION public.enforce_journal_entry_immutability()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_last_number integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF current_setting('gnubok.allow_delete', true) = 'true' THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'Cannot delete journal entries (id: %, status: %). Use cancelled status instead.',
      OLD.id, OLD.status;
  END IF;

  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'posted', 'cancelled') THEN
    IF NEW.status = 'posted' AND current_user IN ('anon', 'authenticated') THEN
      SELECT vs.last_number INTO v_last_number
      FROM public.voucher_sequences vs
      WHERE vs.company_id = NEW.company_id
        AND vs.fiscal_period_id = NEW.fiscal_period_id
        AND vs.voucher_series = NEW.voucher_series;
      IF NEW.voucher_number IS NULL OR NEW.voucher_number <= 0
         OR v_last_number IS NULL OR NEW.voucher_number > v_last_number THEN
        RAISE EXCEPTION 'journal_entries: voucher number % was not issued by the sequence; post through commit_journal_entry',
          NEW.voucher_number USING ERRCODE = '42501';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'posted' AND NEW.status IN ('reversed', 'cancelled') THEN
    IF NEW.status = 'reversed' THEN
      -- Unchanged from the live definition: the storno path sets
      -- reversed_by_id alongside the status, so this stays an enumerated list.
      IF NEW.description != OLD.description OR NEW.entry_date != OLD.entry_date
         OR NEW.fiscal_period_id != OLD.fiscal_period_id
         OR NEW.voucher_number != OLD.voucher_number
         OR NEW.commit_method IS DISTINCT FROM OLD.commit_method
         OR NEW.rubric_version IS DISTINCT FROM OLD.rubric_version
         OR NEW.source_voucher_series IS DISTINCT FROM OLD.source_voucher_series
         OR NEW.source_voucher_number IS DISTINCT FROM OLD.source_voucher_number THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during reversal (id: %)', OLD.id;
      END IF;
    ELSE
      -- cancelled: nothing but the status may move.
      IF (to_jsonb(NEW) - 'status' - 'updated_at') != (to_jsonb(OLD) - 'status' - 'updated_at') THEN
        RAISE EXCEPTION 'Cannot modify fields of a posted entry during cancellation (id: %)', OLD.id;
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
  IF OLD.status = NEW.status
     AND OLD.status IN ('posted', 'reversed', 'cancelled')
     AND (to_jsonb(NEW) - 'notes' - 'updated_at')
       = (to_jsonb(OLD) - 'notes' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Source-type re-tag of a mis-typed opening balance (mark_entry_as_opening_balance).
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_source_type_retag', true) = 'true'
     AND OLD.source_type IN ('manual', 'import')
     AND NEW.source_type = 'opening_balance'
     AND (to_jsonb(NEW) - 'source_type' - 'updated_at')
       = (to_jsonb(OLD) - 'source_type' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  -- Metadata rättelse of a posted verifikation (correct_entry_metadata).
  IF OLD.status = NEW.status
     AND OLD.status = 'posted'
     AND current_setting('gnubok.allow_metadata_rattelse', true) = 'true'
     AND (to_jsonb(NEW) - 'description' - 'entry_date' - 'updated_at')
       = (to_jsonb(OLD) - 'description' - 'entry_date' - 'updated_at') THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Cannot modify a % journal entry (id: %). Committed entries are immutable per Bokforingslagen.',
    OLD.status, OLD.id;
END;
$$;

NOTIFY pgrst, 'reload schema';
