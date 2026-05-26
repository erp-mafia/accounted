-- Add `removed_from_agi` flag to salary_run_employees so a correction can
-- tombstone a previously-submitted individuppgift via Skatteverket FK205
-- Borttag. The xml generator emits the IU with only identity fields
-- (FK201/FK215/FK570/FK006) plus <Borttag>1</Borttag> when this is set —
-- Skatteverket matches on (AgRegistreradId, BetalningsmottagarId,
-- RedovisningsPeriod, Specifikationsnummer) and removes the prior IU.
--
-- Defaults to false. Only meaningful for runs that have an AGI declaration
-- already filed for the period — the UI gates the toggle on that state.

ALTER TABLE salary_run_employees
  ADD COLUMN removed_from_agi BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN salary_run_employees.removed_from_agi IS
  'When true, emit this IU as FK205 Borttag in the next AGI XML so Skatteverket removes the prior individuppgift for this employee+period. Use for corrections where an employee should not have been in the run.';

NOTIFY pgrst, 'reload schema';
