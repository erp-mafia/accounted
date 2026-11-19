-- The fiscal year's close and lock, and the voucher counter, get an owner in
-- the database (audit LED-2, issue #199).
--
-- Until now any writer in the active company could set these columns with a
-- plain UPDATE: fiscal_periods_update and voucher_sequences_update only ask
-- for write access, and nothing owned the transitions. The app's checks (the
-- owner reopen's fail-closed gates, closePeriod's "locked and bokslut first",
-- commit_journal_entry as the only numbering writer) held only as long as
-- every writer went through the app.
--
-- Every writer of these columns on main, and what happens to it here:
--
--   fiscal_periods.is_closed, locked_at, closed_at, closing_entry_id,
--   closed_externally
--     The app, with the caller's client (authenticated for a browser
--     session, service_role for API keys and MCP):
--       lockPeriod, unlockPeriod, closePeriod, markPeriodClosedExternally
--       (klarmarkera) and reopenExternallyClosedPeriod (undo klarmarkera) in
--       lib/core/bookkeeping/period-service.ts; the year-end run linking its
--       bokslutsverifikat (year-end-service.ts); the owner reopen detaching
--       the storno'd closing entry (fiscal-year-reopen.ts).
--       Each is allowed below as exactly that transition, with the state it
--       needs checked here, so the app works unchanged before and after this
--       migration.
--     Support's administrative undo, scripts/undo-year-end-closing.ts
--       (service_role): reopens a year closed with a bokslut, then detaches
--       the storno'd closing entry. Allowed explicitly for service_role only.
--     SQL, all SECURITY DEFINER: reopen_closed_fiscal_year (the owner
--       reopen) and the sandbox teardown cleanup_sandbox_user (clears
--       closing_entry_id). They run as the owner and are not judged here.
--
--   voucher_sequences (last_number and the row itself)
--     SQL only, all SECURITY DEFINER: commit_journal_entry,
--     next_voucher_number, reserve_voucher_range, release_voucher_range,
--     import_sie_journal_entries, write_sie_job_entries, undo_sie_import,
--     undo_sie_import_chunk, undo_sie_duplicate_repair_chunk,
--     replace_sie_import, reset_fiscal_year, delete_last_voucher; plus the
--     foreign key cascade when a period or company is deleted, and the perf
--     bench seeds run in psql as the owner. No app code writes it, so a
--     direct write from the Data API is refused outright.
--
-- How "through their functions" is told apart: a statement run inside a
-- SECURITY DEFINER function (and a foreign key action) runs as the
-- function's owner, a direct write from the Data API runs as anon,
-- authenticated or service_role. The guards read current_user, as
-- guard_sie_period_hold and guard_sie_opening_balance_review already do for
-- import_hold and the review columns, so no existing function is redefined.
--
-- The transitions a direct writer still has (all the app uses):
--   * lock (locked_at NULL -> a time) and unlock (a time -> NULL), only while
--     the year is open;
--   * link the bokslutsverifikat (closing_entry_id -> a posted year_end entry
--     of the same company and year), only while the year is open; detaching
--     stays with enforce_opening_balance_immutability (only once storno'd);
--   * close with a bokslut: locked, closed_at set, closing_entry_id the
--     year's posted year_end entry;
--   * klarmarkera: no closing entry, closed_externally, locked, closed_at
--     set, and the year has ended (stockholm_today, as hasEnded);
--   * undo klarmarkera: only a year closed that way, back to open, unlocked,
--     closed_at and closed_externally cleared;
--   * a new period starts open, unlocked and without a closing entry.
-- Everything else is refused (42501): above all, reopening a year closed
-- with a bokslut, which goes through reopen_closed_fiscal_year and its gates,
-- and any change to the close, lock or closing entry of a closed year.
--
-- What stays in the app only: lockPeriod's and klarmarkera's unbooked bank
-- transaction check and klarmarkera's ledger-shape check. Both protect the
-- writer from themselves and are reversible (unlock, undo klarmarkera).
--
-- Row triggers fire in name order: guard_state_close_lock sorts after
-- enforce_opening_balance_immutability and guard_sie_period_hold, so a
-- detach before the storno and a close or lock during an SIE import keep
-- their own messages. No table, policy, grant or enforcement trigger from
-- 20240101000017 is changed; no data is written.
--
-- pg-test: covered-by tests/pg/fiscal-period-close-lock-owner.pg.test.ts

CREATE OR REPLACE FUNCTION public.guard_fiscal_period_close_lock()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
DECLARE
  v_was_closed boolean;
  v_is_closed  boolean;
BEGIN
  -- SECURITY DEFINER functions and foreign key actions run as the owner.
  IF current_user NOT IN ('anon', 'authenticated', 'service_role') THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF coalesce(NEW.is_closed, false)
       OR NEW.locked_at IS NOT NULL
       OR NEW.closed_at IS NOT NULL
       OR NEW.closing_entry_id IS NOT NULL
       OR coalesce(NEW.closed_externally, false) THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: a new fiscal period starts open, unlocked and without a closing entry'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.is_closed IS NOT DISTINCT FROM OLD.is_closed
     AND NEW.locked_at IS NOT DISTINCT FROM OLD.locked_at
     AND NEW.closed_at IS NOT DISTINCT FROM OLD.closed_at
     AND NEW.closing_entry_id IS NOT DISTINCT FROM OLD.closing_entry_id
     AND NEW.closed_externally IS NOT DISTINCT FROM OLD.closed_externally THEN
    RETURN NEW;
  END IF;

  v_was_closed := coalesce(OLD.is_closed, false);
  v_is_closed  := coalesce(NEW.is_closed, false);

  -- An open year that stays open: lock, unlock, link the bokslutsverifikat.
  IF NOT v_was_closed AND NOT v_is_closed THEN
    IF OLD.locked_at IS NOT NULL AND NEW.locked_at IS NOT NULL
       AND NEW.locked_at IS DISTINCT FROM OLD.locked_at THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: a lock time is set by locking and cleared by unlocking, never rewritten'
        USING ERRCODE = '42501';
    END IF;
    -- An open year may drop a stale closed_at, never gain one.
    IF NEW.closed_at IS NOT NULL AND NEW.closed_at IS DISTINCT FROM OLD.closed_at THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: closed_at is set only by closing the fiscal period'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.closed_externally IS DISTINCT FROM OLD.closed_externally THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: closed_externally changes only with klarmarkera and its undo'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.closing_entry_id IS NOT NULL
       AND NEW.closing_entry_id IS DISTINCT FROM OLD.closing_entry_id
       AND NOT EXISTS (
         SELECT 1 FROM public.journal_entries je
          WHERE je.id = NEW.closing_entry_id
            AND je.company_id = NEW.company_id
            AND je.fiscal_period_id = NEW.id
            AND je.source_type = 'year_end'
            AND je.status = 'posted'
       ) THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: closing_entry_id must be the posted year_end entry of this fiscal period'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Closing: with the bokslut booked here, or klarmarkera for a year closed
  -- in the previous system. Either way locked and with its close time.
  IF NOT v_was_closed AND v_is_closed THEN
    IF NEW.locked_at IS NULL OR NEW.closed_at IS NULL THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: a fiscal period is closed locked and with closed_at set'
        USING ERRCODE = '42501';
    END IF;
    IF NEW.closing_entry_id IS NOT NULL THEN
      IF NEW.closed_externally IS DISTINCT FROM OLD.closed_externally THEN
        RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: a year with its closing entry here is closed with it, not marked closed in the previous system'
          USING ERRCODE = '42501';
      END IF;
      IF NOT EXISTS (
           SELECT 1 FROM public.journal_entries je
            WHERE je.id = NEW.closing_entry_id
              AND je.company_id = NEW.company_id
              AND je.fiscal_period_id = NEW.id
              AND je.source_type = 'year_end'
              AND je.status = 'posted'
         ) THEN
        RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: a year closed with a bokslut needs its posted year_end entry'
          USING ERRCODE = '42501';
      END IF;
    ELSIF NOT coalesce(NEW.closed_externally, false)
          OR NOT (NEW.period_end < public.stockholm_today()) THEN
      RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: without a bokslut here, only a year that has ended can be marked closed in the previous system'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- Reopening.
  IF v_was_closed AND NOT v_is_closed THEN
    -- Undo klarmarkera: the close was a person's decision, not a bokslut here.
    IF coalesce(OLD.closed_externally, false)
       AND OLD.closing_entry_id IS NULL
       AND NEW.closing_entry_id IS NULL
       AND NOT coalesce(NEW.closed_externally, false)
       AND NEW.closed_at IS NULL
       AND NEW.locked_at IS NULL THEN
      RETURN NEW;
    END IF;
    -- Support's administrative undo of a bokslut
    -- (scripts/undo-year-end-closing.ts, service role only): opens and
    -- unlocks the year and keeps the closing entry attached until its storno
    -- is posted.
    IF current_user = 'service_role'
       AND OLD.closing_entry_id IS NOT NULL
       AND NEW.closing_entry_id IS NOT DISTINCT FROM OLD.closing_entry_id
       AND NEW.closed_externally IS NOT DISTINCT FROM OLD.closed_externally
       AND NEW.closed_at IS NULL
       AND NEW.locked_at IS NULL THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: a year closed with a bokslut is reopened through reopen_closed_fiscal_year'
      USING ERRCODE = '42501';
  END IF;

  -- A closed year that stays closed keeps its close, lock and closing entry.
  RAISE EXCEPTION 'FISCAL_PERIOD_STATE_GUARDED: a closed fiscal period keeps its close, lock and closing entry'
    USING ERRCODE = '42501';
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_fiscal_period_close_lock() FROM PUBLIC;

COMMENT ON FUNCTION public.guard_fiscal_period_close_lock() IS
  'Owns the close and lock columns of fiscal_periods (is_closed, locked_at, closed_at, closing_entry_id, closed_externally). A direct write (anon, authenticated, service_role) gets only the transitions the app makes: lock, unlock, link the bokslutsverifikat, close with a bokslut, klarmarkera and its undo. Reopening a year closed with a bokslut goes through reopen_closed_fiscal_year. SECURITY DEFINER functions run as the owner and pass. Issue #199 (LED-2).';

DROP TRIGGER IF EXISTS guard_state_close_lock ON public.fiscal_periods;
CREATE TRIGGER guard_state_close_lock
  BEFORE INSERT OR UPDATE OF is_closed, locked_at, closed_at, closing_entry_id, closed_externally
  ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_period_close_lock();

CREATE OR REPLACE FUNCTION public.guard_voucher_sequence_writer()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  -- Numbering functions (SECURITY DEFINER) and foreign key cascades run as
  -- the owner; a direct write from the Data API does not.
  IF current_user IN ('anon', 'authenticated', 'service_role') THEN
    RAISE EXCEPTION 'VOUCHER_SEQUENCE_GUARDED: voucher numbers are assigned by commit_journal_entry and the numbering functions, never written directly'
      USING ERRCODE = '42501';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_voucher_sequence_writer() FROM PUBLIC;

COMMENT ON FUNCTION public.guard_voucher_sequence_writer() IS
  'voucher_sequences is written only by the numbering functions (commit_journal_entry, next_voucher_number, the reserve/release and SIE import/undo/reset functions), all SECURITY DEFINER. A direct INSERT, UPDATE or DELETE from anon, authenticated or service_role is refused, so last_number cannot be rewound or skipped ahead (Hard Rule 2, BFNAR 2013:2). Issue #199 (LED-2).';

DROP TRIGGER IF EXISTS voucher_sequences_written_by_numbering_functions ON public.voucher_sequences;
CREATE TRIGGER voucher_sequences_written_by_numbering_functions
  BEFORE INSERT OR UPDATE OR DELETE ON public.voucher_sequences
  FOR EACH ROW EXECUTE FUNCTION public.guard_voucher_sequence_writer();

NOTIFY pgrst, 'reload schema';
