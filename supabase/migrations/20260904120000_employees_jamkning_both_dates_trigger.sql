-- Enforce the jämkning both-dates invariant in the database (#2256).
--
-- A jämkningsbeslut (Skatteverket beslut om ändrad beräkning av skatteavdrag)
-- on an employee is a percentage with a validity window. The calculation
-- engine (isJamkningValid in lib/salary/calculation-engine.ts) applies the
-- beslut only when BOTH jamkning_valid_from and jamkning_valid_to are set and
-- the payment date falls inside them. A percentage stored without an end date
-- is therefore inert: the payslip and the AGI carry the table tax while the
-- stored beslut says otherwise, and nobody is told.
--
-- PR #2240 closed that shape on every application write path through
-- lib/salary/jamkning-rules.ts (validateJamkning), but two gaps remained
-- because the rule lived only in application code:
--
--   1. Concurrent PATCHes: both handlers validate a fetched snapshot and then
--      issue an unconditional partial update. Request A writes a complete
--      beslut while request B sends { jamkning_valid_to: null }; both
--      validations pass against the previous empty row, and if B commits
--      last the row holds a percentage without an end date.
--   2. Direct SQL and service-role writes bypass the validator entirely.
--
-- This trigger is the all-paths backstop. It mirrors validateJamkning exactly:
--
--   * a non-null jamkning_percentage requires both dates;
--   * when both dates are present, jamkning_valid_to must not precede
--     jamkning_valid_from (checked whether or not a percentage is set, as
--     the validator and the Zod update schema do);
--   * a null percentage clears the beslut and leaves the dates free.
--
-- It fires on INSERT always, and on UPDATE only when one of the three
-- jamkning columns actually CHANGES (IS DISTINCT FROM on OLD vs NEW). The
-- column list on the trigger already keeps an UPDATE that never mentions the
-- columns out, and the change check additionally lets a route that sends the
-- whole row back (unchanged jamkning values included) through. Together they
-- give the same "touched gate" the routes use: a legacy row stored with an
-- incomplete beslut before #2240 stays editable in unrelated ways, since
-- fixing it requires touching these very fields. A write that touches the
-- jamkning columns and leaves the row incomplete is refused on every path.
--
-- The error is SQLSTATE 23514 (check_violation) with a message that starts
-- with the stable prefix "JAMKNING_INCOMPLETE: " followed by the same Swedish
-- sentence validateJamkning produces for that field, so the application can
-- match the prefix and surface the identical user-facing text
-- (jamkningMessageFromDbError in lib/salary/jamkning-rules.ts).
--
-- No backfill: existing incomplete rows are listed read-only by
-- scripts/list-incomplete-jamkning.ts and decided per company. The trigger
-- never rewrites data; it only refuses new incomplete state.

CREATE OR REPLACE FUNCTION public.enforce_employee_jamkning_dates()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO 'public'
AS $$
BEGIN
  -- Change gate: an UPDATE that leaves all three jamkning columns as they
  -- were is never checked, so a legacy incomplete row can still be edited
  -- in unrelated ways even when the caller writes the whole row back.
  IF TG_OP = 'UPDATE'
     AND NEW.jamkning_percentage IS NOT DISTINCT FROM OLD.jamkning_percentage
     AND NEW.jamkning_valid_from IS NOT DISTINCT FROM OLD.jamkning_valid_from
     AND NEW.jamkning_valid_to IS NOT DISTINCT FROM OLD.jamkning_valid_to THEN
    RETURN NEW;
  END IF;

  IF NEW.jamkning_percentage IS NOT NULL AND NEW.jamkning_valid_from IS NULL THEN
    RAISE EXCEPTION 'JAMKNING_INCOMPLETE: Jämkningens startdatum måste anges när jämkningsprocent sätts'
      USING ERRCODE = 'check_violation',
            DETAIL = 'employees.jamkning_percentage is set but jamkning_valid_from is null (#2256)',
            COLUMN = 'jamkning_valid_from';
  END IF;

  IF NEW.jamkning_percentage IS NOT NULL AND NEW.jamkning_valid_to IS NULL THEN
    RAISE EXCEPTION 'JAMKNING_INCOMPLETE: Jämkningens slutdatum måste anges när jämkningsprocent sätts'
      USING ERRCODE = 'check_violation',
            DETAIL = 'employees.jamkning_percentage is set but jamkning_valid_to is null (#2256)',
            COLUMN = 'jamkning_valid_to';
  END IF;

  IF NEW.jamkning_valid_from IS NOT NULL
     AND NEW.jamkning_valid_to IS NOT NULL
     AND NEW.jamkning_valid_to < NEW.jamkning_valid_from THEN
    RAISE EXCEPTION 'JAMKNING_INCOMPLETE: Jämkningens slutdatum måste vara efter startdatumet'
      USING ERRCODE = 'check_violation',
            DETAIL = 'employees.jamkning_valid_to precedes jamkning_valid_from (#2256)',
            COLUMN = 'jamkning_valid_to';
  END IF;

  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_employee_jamkning_dates() IS
  'Backstop for lib/salary/jamkning-rules.ts (#2256): a non-null jamkning_percentage needs both jamkning_valid_from and jamkning_valid_to, and valid_to may not precede valid_from. Raises 23514 with a JAMKNING_INCOMPLETE: prefix. On UPDATE it checks only when a jamkning column actually changes, so legacy incomplete rows stay editable in unrelated ways.';

DROP TRIGGER IF EXISTS trg_enforce_employee_jamkning_dates ON public.employees;
CREATE TRIGGER trg_enforce_employee_jamkning_dates
  BEFORE INSERT OR UPDATE OF jamkning_percentage, jamkning_valid_from, jamkning_valid_to
  ON public.employees
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_employee_jamkning_dates();

COMMENT ON TRIGGER trg_enforce_employee_jamkning_dates ON public.employees IS
  'Jämkning both-dates invariant (#2256): refuses a percentage without both validity dates, or an end date before the start date, on INSERT and on any UPDATE that changes a jamkning column. Mirrors validateJamkning in lib/salary/jamkning-rules.ts. No backfill of rows stored before this trigger.';

NOTIFY pgrst, 'reload schema';
