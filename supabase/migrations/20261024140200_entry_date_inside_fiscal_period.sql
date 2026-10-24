-- A verifikat's date lies inside the fiscal year it is booked in, enforced
-- in the database.
--
-- Reports read a year two ways: by journal_entries.fiscal_period_id (the
-- trial balance, huvudbok, resultaträkning) and by entry_date (the derived
-- opening balance, the momsdeklaration). An entry dated outside the year it
-- references is counted in one year by the first and in another by the
-- second, so the reports disagree. Prod holds 710 such entries (2026-10-24):
-- SIE imports from before the import's date guard, stornos and corrections
-- from before storno-target.ts checked the reversal date, and payments in
-- seeded demo companies. Every writer in the code is fixed, but the rule
-- lived only in application code (engine.ts createDraftEntry and
-- updateDraftEntry, storno-target.ts, the SIE job writer, redate_fiscal_period),
-- so two paths could still break it:
--   - a writing member inserts or edits a draft through PostgREST with any
--     date and period, then posts it with commit_journal_entry, which checks
--     neither;
--   - a writing member updates fiscal_periods.period_start/period_end
--     directly, which re-checks no entry (only the redate_fiscal_period RPC
--     does).
--
-- 1. enforce_entry_date_in_fiscal_period on journal_entries: a row that is
--    not cancelled must be dated inside its fiscal period's
--    period_start..period_end whenever it is inserted, re-dated, moved to
--    another period, or posted from a draft. A posted -> reversed status
--    flip is not checked, so a misdated original can still be reversed. A
--    storno that mirrors its original's date and period is exempt: the
--    historical misdated SIE imports stay undoable (undo_sie_import_chunk
--    copies each original's date into the import's period).
-- 2. guard_fiscal_period_redate_entries on fiscal_periods: new dates may not
--    leave outside the year an entry that is inside it today. Entries that
--    are already outside it (the historical ones) do not block an unrelated
--    redate. redate_fiscal_period refuses these cases first, with every
--    blocker named; this is the floor under a direct UPDATE.
--
-- Both raise a registered code (lib/errors/structured-errors.ts), so the
-- user reads its Swedish sentence: ENTRY_DATE_OUTSIDE_FISCAL_PERIOD and
-- FISCAL_PERIOD_DATES_BLOCKED. The existing 710 entries are a data repair
-- (storno and rebook in the right year), not part of this migration.
--
-- SECURITY INVOKER like enforce_period_lock: the period and the original are
-- read with the caller's rights. A caller always sees its own company's
-- periods and entries, and the service role and SECURITY DEFINER writers
-- see everything. The journal trigger is named to fire after the other
-- BEFORE triggers, so the lock and immutability refusals keep their own
-- messages and this one sees the row as it will be written.

-- 1 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.enforce_entry_date_in_fiscal_period()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_start date;
  v_end date;
  v_name text;
BEGIN
  IF NEW.status = 'cancelled' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'UPDATE'
     AND NEW.entry_date IS NOT DISTINCT FROM OLD.entry_date
     AND NEW.fiscal_period_id IS NOT DISTINCT FROM OLD.fiscal_period_id
     AND NOT (OLD.status = 'draft' AND NEW.status = 'posted') THEN
    RETURN NEW;
  END IF;

  SELECT fp.period_start, fp.period_end, fp.name
    INTO v_start, v_end, v_name
    FROM public.fiscal_periods fp
   WHERE fp.id = NEW.fiscal_period_id;

  IF NOT FOUND OR NEW.entry_date BETWEEN v_start AND v_end THEN
    RETURN NEW;
  END IF;

  IF NEW.reverses_id IS NOT NULL AND EXISTS (
    SELECT 1
      FROM public.journal_entries o
     WHERE o.id = NEW.reverses_id
       AND o.entry_date = NEW.entry_date
       AND o.fiscal_period_id = NEW.fiscal_period_id
  ) THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'ENTRY_DATE_OUTSIDE_FISCAL_PERIOD: verifikationsdatumet % ligger utanför räkenskapsåret % (% till %)',
    NEW.entry_date, v_name, v_start, v_end
    USING ERRCODE = 'check_violation';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_entry_date_in_fiscal_period() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS zz_enforce_entry_date_in_fiscal_period ON public.journal_entries;
CREATE TRIGGER zz_enforce_entry_date_in_fiscal_period
  BEFORE INSERT OR UPDATE OF entry_date, fiscal_period_id, status ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_entry_date_in_fiscal_period();

COMMENT ON FUNCTION public.enforce_entry_date_in_fiscal_period() IS
  'A journal entry that is not cancelled is dated inside its fiscal period, checked on insert, re-date, period move and draft -> posted. A storno mirroring its original''s date and period is exempt.';

-- 2 ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_fiscal_period_redate_entries()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_count integer;
BEGIN
  IF NEW.period_start IS NOT DISTINCT FROM OLD.period_start
     AND NEW.period_end IS NOT DISTINCT FROM OLD.period_end THEN
    RETURN NEW;
  END IF;

  SELECT count(*)
    INTO v_count
    FROM public.journal_entries e
   WHERE e.fiscal_period_id = NEW.id
     AND e.status <> 'cancelled'
     AND e.entry_date BETWEEN OLD.period_start AND OLD.period_end
     AND (e.entry_date < NEW.period_start OR e.entry_date > NEW.period_end);

  IF v_count > 0 THEN
    RAISE EXCEPTION 'FISCAL_PERIOD_DATES_BLOCKED: % verifikationer skulle hamna utanför räkenskapsåret % till %',
      v_count, NEW.period_start, NEW.period_end
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_fiscal_period_redate_entries() FROM PUBLIC, anon;

DROP TRIGGER IF EXISTS guard_fiscal_period_redate_entries ON public.fiscal_periods;
CREATE TRIGGER guard_fiscal_period_redate_entries
  BEFORE UPDATE OF period_start, period_end ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_period_redate_entries();

COMMENT ON FUNCTION public.guard_fiscal_period_redate_entries() IS
  'New fiscal period dates may not leave outside the year an entry that is inside it today (redate_fiscal_period checks first; this guards a direct UPDATE).';
