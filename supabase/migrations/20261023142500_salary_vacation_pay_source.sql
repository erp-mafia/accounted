-- Engine provenance for pay derived from vacation days taken (issue #85).
-- pg-test: tests/pg/salary-vacation-pay-source.pg.test.ts
--
-- A vacation payslip line (item_type 'vacation', quantity = days off) that
-- carries no amount is now priced by lib/salary/run-calculation.ts
-- (lib/salary/vacation-days-pay.ts): the semestertillägg under
-- sammalöneregeln (Semesterlagen 16 a §), the semesterlöneavdrag and the
-- semesterlön under procentregeln (16 b §, 22 §), and the deduction for an
-- obetald semesterdag (8 §). Those rows are written and replaced by every
-- calculation, so they carry calculation_source 'vacation_pay', and the
-- line commands refuse to edit them (calculated-line-items.ts). NULL stays a
-- manual row and 'vacation_compensation' keeps its meaning.
--
-- The new value is allowed on item_type 'vacation' only: the provenance
-- says "derived from vacation days", and the vacation ledger, the account
-- map and Fora read the rows by that type.
--
-- Additive: every existing row is NULL or 'vacation_compensation' and
-- passes; code that does not know the value never writes it. Added NOT VALID
-- and validated in 20261023142600, the split 20260919120000 / 20260919120300
-- used, so the DDL takes the lighter lock.

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT IF EXISTS salary_line_items_calculation_source_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_calculation_source_check
  CHECK (
    calculation_source IS NULL
    OR calculation_source = 'vacation_compensation'
    OR (calculation_source = 'vacation_pay' AND item_type = 'vacation')
  )
  NOT VALID;

COMMENT ON COLUMN public.salary_line_items.calculation_source IS
  'Engine provenance: vacation_compensation on the semesterersättning row run-calculation derives and replaces on every calculate; vacation_pay on the vacation rows it derives from vacation days taken (semestertillägg, semesterlön, semesterlöneavdrag, obetald semester). NULL = manually entered row, preserved across recalculations.';

NOTIFY pgrst, 'reload schema';
