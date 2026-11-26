-- A payslip row of semesterlön for rörliga lönedelar paid with the salary
-- under a central kollektivavtal (sammalöneregeln).
-- pg-test: tests/pg/salary-line-settles-variable-vacation-pay.pg.test.ts
--
-- Under sammalöneregeln the variable pay (OB, övertid, bonus, provision)
-- earns its own semesterlön, 12 % or the employee's rate (Semesterlagen
-- 16 a § tredje stycket), paid at the latest one month after the semesterår
-- (26 § andra stycket). lib/salary/variable-vacation-pay.ts accrues it per
-- run and pays it in the first run after the year. A central kollektivavtal
-- may deviate from 16 a § and 26 § (2 a § andra stycket) and let it be paid
-- with each salary instead. A hand-entered semesterersättning row of that
-- kind was counted nowhere, so the same semesterlön was accrued and paid a
-- second time after the semesterår.
--
-- settles_variable_vacation_pay marks such a row: the operator's word that
-- the agreement applies, recorded in audit_log when the row is written
-- (lib/salary/payslip-lines.ts). The calculation then counts the row as
-- semesterlön already paid on the rörliga lönedelar: it lowers the run's
-- accrual and the payout after the semesterår.
--
-- Only a manual semesterersättning row can carry it: the engine's own
-- payout row (calculation_source 'vacation_compensation') is the payment
-- the mark replaces, and no other type is semesterlön.
--
-- Additive: the column defaults to false, so every existing row keeps its
-- meaning, and code that does not know the column never writes it. The
-- CHECK is added NOT VALID and validated in 20261125180100, the split
-- 20261023142500 / 20261023142600 used, so the DDL takes the lighter lock.

ALTER TABLE public.salary_line_items
  ADD COLUMN IF NOT EXISTS settles_variable_vacation_pay boolean NOT NULL DEFAULT false;

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT IF EXISTS salary_line_items_settles_variable_vacation_pay_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_settles_variable_vacation_pay_check
  CHECK (
    NOT settles_variable_vacation_pay
    OR (item_type = 'semesterersattning' AND calculation_source IS NULL)
  )
  NOT VALID;

COMMENT ON COLUMN public.salary_line_items.settles_variable_vacation_pay IS
  'True on a manual semesterersättning row that pays semesterlön for rörliga lönedelar with the salary under a central kollektivavtal (Semesterlagen 2 a § andra stycket, 16 a § tredje stycket, 26 § andra stycket). Under sammalöneregeln the calculation counts it as already paid: it lowers the run''s accrual and the payout after the semesterår. The confirmation is in audit_log.';

NOTIFY pgrst, 'reload schema';
