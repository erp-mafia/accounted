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
-- lib/salary/jamkning-rules.ts (validateJamkning), but the rule lived only in
-- application code, across many writers: two PATCH handlers that validate a
-- fetched snapshot and then write unconditionally can interleave so that the
-- last one leaves a percentage without an end date, and direct SQL or
-- service-role writes never see the validator at all.
--
-- The invariant is a row-level fact, so it is declared as a row-level CHECK
-- constraint, the same rule validateJamkning applies:
--
--   * a non-null jamkning_percentage requires both dates;
--   * when both dates are present, jamkning_valid_to may not precede
--     jamkning_valid_from (also when no percentage is set, as the validator
--     and the Zod update schema do);
--   * a null percentage clears the beslut and leaves the dates free.
--
-- NOT VALID: the constraint is not checked against rows that already exist,
-- so this migration cannot fail on production because of the incomplete
-- rows stored before #2240. From now on every INSERT and every UPDATE of any
-- row is checked, whatever columns the UPDATE names. Consequence for a
-- legacy incomplete row: its next edit, related or not, is refused with
-- SQLSTATE 23514 until the beslut is completed (both dates) or cleared
-- (percentage null); the application maps that to the validator's Swedish
-- sentence (jamkningIssueFromDbError in lib/salary/jamkning-rules.ts). Those
-- rows are listed read-only by scripts/list-incomplete-jamkning.ts and
-- decided per company. No backfill here: this migration never rewrites data.
--
-- Not validated later on purpose: VALIDATE CONSTRAINT would fail while any
-- legacy row remains, and the constraint already protects every new write.

ALTER TABLE public.employees
  ADD CONSTRAINT employees_jamkning_dates_check CHECK (
    (
      jamkning_percentage IS NULL
      OR (jamkning_valid_from IS NOT NULL AND jamkning_valid_to IS NOT NULL)
    )
    AND (
      jamkning_valid_from IS NULL
      OR jamkning_valid_to IS NULL
      OR jamkning_valid_to >= jamkning_valid_from
    )
  ) NOT VALID;

COMMENT ON CONSTRAINT employees_jamkning_dates_check ON public.employees IS
  'Jämkning both-dates invariant (#2256): a non-null jamkning_percentage needs both jamkning_valid_from and jamkning_valid_to, and valid_to may not precede valid_from. Mirrors validateJamkning in lib/salary/jamkning-rules.ts. Added NOT VALID: rows stored before this constraint are checked on their next UPDATE, not backfilled.';

NOTIFY pgrst, 'reload schema';
