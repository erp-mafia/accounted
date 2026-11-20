-- Text rows on the payslip (item_type 'text', "Textrad").
--
-- A collective agreement can require the payslip to explain how the salary is
-- built up (a line of words between the money rows). The only way to get
-- words onto a payslip was a money row with amount 0, which printed "0,00"
-- and looked like a pay item. A text row carries words and nothing else:
-- amount 0, no quantity, no unit price, no account, every compliance flag
-- false, so the engine, the booking, the AGI and the year-to-date totals
-- never see it.
--
-- The text is stored per run in salary_line_items like every other row, not
-- read live from a template: an issued payslip keeps the text it was issued
-- with and never changes afterwards (BFL 7 kap. 1 §). A standing text lives
-- on employee_recurring_lines and is copied into each run.
--
-- 1. salary_line_items: the item_type list from 20260906210300 plus 'text',
--    and salary_line_items_text_row binding a text row to its shape. Both
--    added NOT VALID; the VALIDATE runs in 20261014233100 so the scan does not
--    hold the stronger DDL lock (same split as 20260906210300 / 210301).
--    No existing row is 'text', so the scan finds nothing to refuse.
-- 2. employee_recurring_lines: 'text' joins the five deduction types, the
--    amount sign rule exempts it (a text row is 0, never negative) and
--    employee_recurring_lines_text_row pins amount 0 and no account. A small
--    table, so the constraints are added validated in place.
--
-- pg-test: covered-by tests/pg/payslip-text-rows.pg.test.ts

-- ---------------------------------------------------------------------------
-- 1. salary_line_items
-- ---------------------------------------------------------------------------

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT salary_line_items_item_type_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_item_type_check
  CHECK (item_type IN (
    'monthly_salary', 'hourly_salary',
    'overtime', 'overtime_50', 'overtime_100',
    'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday',
    'bonus', 'commission',
    'gross_deduction_pension', 'gross_deduction_other',
    'benefit_car', 'benefit_housing', 'benefit_meals',
    'benefit_wellness', 'benefit_bike', 'benefit_other',
    'sick_karens', 'sick_day2_14', 'sick_day15_plus',
    'vab', 'parental_leave', 'unpaid_leave',
    'vacation', 'semesterersattning',
    'traktamente_taxfree', 'traktamente_taxable',
    'mileage_taxfree', 'mileage_taxable',
    'expense_reimbursement',
    'net_deduction_advance', 'net_deduction_union',
    'net_deduction_benefit_payment', 'net_deduction_other',
    'oresavrundning',
    'correction', 'other',
    'text'
  )) NOT VALID;

-- Mirrors validateTextRow (src/lib/salary/text-rows.ts): words only. The flag
-- columns are NOT NULL, so NOT is_x is never NULL and cannot slip a row past
-- the CHECK. "Not blank" means at least one non-space character: btrim alone
-- strips only spaces and would let a text of tabs or line breaks through.
ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_text_row
  CHECK (
    item_type <> 'text'
    OR (
      amount = 0
      AND quantity IS NULL
      AND unit_price IS NULL
      AND account_number IS NULL
      AND NOT is_taxable
      AND NOT is_avgift_basis
      AND NOT is_vacation_basis
      AND NOT is_gross_deduction
      AND NOT is_net_deduction
      AND description ~ '[^[:space:]]'
    )
  ) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. employee_recurring_lines
-- ---------------------------------------------------------------------------

ALTER TABLE public.employee_recurring_lines
  DROP CONSTRAINT employee_recurring_lines_item_type_check;

ALTER TABLE public.employee_recurring_lines
  ADD CONSTRAINT employee_recurring_lines_item_type_check
  CHECK (item_type IN (
    'gross_deduction_pension',
    'gross_deduction_other',
    'net_deduction_union',
    'net_deduction_benefit_payment',
    'net_deduction_other',
    'text'
  ));

ALTER TABLE public.employee_recurring_lines
  DROP CONSTRAINT employee_recurring_lines_amount_sign;

ALTER TABLE public.employee_recurring_lines
  ADD CONSTRAINT employee_recurring_lines_amount_sign
  CHECK (item_type = 'text' OR amount < 0);

ALTER TABLE public.employee_recurring_lines
  ADD CONSTRAINT employee_recurring_lines_text_row
  CHECK (item_type <> 'text' OR (amount = 0 AND account_number IS NULL));

NOTIFY pgrst, 'reload schema';
