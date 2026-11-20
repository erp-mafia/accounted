-- A benefit payment names the benefit it pays for (crm#1492).
-- pg-test: tests/pg/salary-benefit-payment-benefit-type.pg.test.ts
--
-- A nettolöneavdrag that is the employee's payment for a benefit lowers the
-- taxable förmånsvärde of THAT benefit (swedish-payroll skill,
-- deductions-lonevaxling.md), and the AGI reports each benefit type in its
-- own field. The payment row (item_type 'net_deduction_benefit_payment')
-- carried no link to a benefit, so a payslip with two benefit types and a
-- payment was refused (lib/salary/benefit-payments.ts).
--
-- benefit_type names the benefit in employee_benefits' own vocabulary
-- ('car' is the payslip's 'benefit_car' row). It is allowed on the payment
-- item type only. NULL keeps today's meaning: the payslip's only benefit
-- type. The recurring line carries it and every calculation copies it onto
-- the derived payslip row, where the engine, the AGI and the booking read it.
--
-- Additive: a new nullable column, every existing row NULL and passing the
-- CHECK. Both tables are small, so the CHECK is validated in place.

ALTER TABLE public.employee_recurring_lines
  ADD COLUMN benefit_type text,
  ADD CONSTRAINT employee_recurring_lines_benefit_type_check CHECK (
    benefit_type IS NULL
    OR (
      item_type = 'net_deduction_benefit_payment'
      AND benefit_type IN ('bike', 'car', 'meals', 'housing', 'wellness', 'other')
    )
  );

ALTER TABLE public.salary_line_items
  ADD COLUMN benefit_type text,
  ADD CONSTRAINT salary_line_items_benefit_type_check CHECK (
    benefit_type IS NULL
    OR (
      item_type = 'net_deduction_benefit_payment'
      AND benefit_type IN ('bike', 'car', 'meals', 'housing', 'wellness', 'other')
    )
  );

COMMENT ON COLUMN public.employee_recurring_lines.benefit_type IS
  'On a net_deduction_benefit_payment line: the benefit the payment is for, as employee_benefits.benefit_type. NULL = the payslip''s only benefit type. Copied onto every derived payslip row.';

COMMENT ON COLUMN public.salary_line_items.benefit_type IS
  'On a net_deduction_benefit_payment row: the benefit the payment is for, as employee_benefits.benefit_type. It lowers that benefit''s taxable value and its default account follows that benefit. NULL = the payslip''s only benefit type.';

NOTIFY pgrst, 'reload schema';
