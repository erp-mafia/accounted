-- Kollektivavtal semesterlön percentage (issue #2477).
--
-- Semesterlagen 16 b § sets 12 % (14.4 % at 30 days) as the procentregeln
-- floor; 2 a § lets a kollektivavtal raise it (13 % and 13.5 % are common in
-- LO agreements). The rate used to be hardcoded in the engine, so a CBA
-- company could not run payroll correctly.
--
-- vacation_pay_rate: decimal fraction (0.135 = 13.5 %). NULL means the
-- statutory rate, so every existing employee is byte-identical after this
-- migration. Only read under vacation_rule = 'procentregeln' and
-- 'semesterersattning'; sammalöneregeln keeps its own semestertillagg_rate.
--
-- Bounds: below the statutory floor is illegal; above 30 % is a unit typo
-- (13.5 entered raw instead of 0.135).

BEGIN;

ALTER TABLE public.employees
  ADD COLUMN IF NOT EXISTS vacation_pay_rate numeric NULL;

ALTER TABLE public.employees
  DROP CONSTRAINT IF EXISTS employees_vacation_pay_rate_check;

ALTER TABLE public.employees
  ADD CONSTRAINT employees_vacation_pay_rate_check
  CHECK (vacation_pay_rate IS NULL OR (vacation_pay_rate >= 0.12 AND vacation_pay_rate <= 0.30));

COMMENT ON COLUMN public.employees.vacation_pay_rate IS
  'Kollektivavtal semesterlön rate under procentregeln/semesterersattning as a fraction (0.135 = 13.5 %). NULL = statutory 12 % (14.4 % at 30 days). Not used by sammalöneregeln.';

COMMIT;

NOTIFY pgrst, 'reload schema';
