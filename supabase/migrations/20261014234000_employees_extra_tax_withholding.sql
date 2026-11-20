-- Förhöjt skatteavdrag per employee (SFL 11 kap. 22 §).
--
-- An employee may ask the employer to withhold more preliminary tax than the
-- table or the jämkningsbeslut gives. The employer "ska" then make the higher
-- deduction from the main income, no later than from the first payment two
-- weeks after the request; no decision from Skatteverket is needed. Until now
-- the only way was the per-run tax override in review, retyped every month,
-- in kronor only and outside the calculation, so the breakdown showed the
-- table tax.
--
-- Two forms, at most one set per employee:
--   * extra_tax_amount: whole kronor added to every pay run;
--   * extra_tax_percentage: the requested total, withhold the higher of the
--     statutory tax and this share of the taxable income.
-- The salary engine (lib/salary/extra-tax.ts) adds the extra after the
-- statutory tax in the table and jämkning branches only, capped at the cash
-- pay left. It lands in salary_run_employees.tax_withheld, so the booking on
-- 2710, AGI field 001, the payslip, the year-to-date totals and the bank file
-- follow unchanged. extra_tax_withheld keeps the part that was extra on each
-- payslip, so a payslip downloaded again later still prints the split.

ALTER TABLE public.employees
  ADD COLUMN extra_tax_amount integer
    CONSTRAINT employees_extra_tax_amount_check
    CHECK (extra_tax_amount BETWEEN 1 AND 1000000),
  ADD COLUMN extra_tax_percentage numeric(5,2)
    CONSTRAINT employees_extra_tax_percentage_check
    CHECK (extra_tax_percentage > 0 AND extra_tax_percentage <= 100),
  ADD CONSTRAINT employees_extra_tax_one_form_check
    CHECK (extra_tax_amount IS NULL OR extra_tax_percentage IS NULL);

COMMENT ON COLUMN public.employees.extra_tax_amount IS
  'Förhöjt skatteavdrag the employee asked for (SFL 11 kap. 22 §), whole kronor added to the statutory tax on every pay run. NULL = none. Exclusive with extra_tax_percentage.';
COMMENT ON COLUMN public.employees.extra_tax_percentage IS
  'Förhöjt skatteavdrag as a requested total (SFL 11 kap. 22 §): withhold the higher of the statutory tax and this percentage of the taxable income. NULL = none. Exclusive with extra_tax_amount.';
COMMENT ON CONSTRAINT employees_extra_tax_one_form_check ON public.employees IS
  'At most one form of förhöjt skatteavdrag per employee. Mirrors validateExtraTax in lib/salary/extra-tax.ts.';

ALTER TABLE public.salary_run_employees
  ADD COLUMN extra_tax_withheld numeric NOT NULL DEFAULT 0
    CONSTRAINT salary_run_employees_extra_tax_withheld_check
    CHECK (extra_tax_withheld >= 0);

COMMENT ON COLUMN public.salary_run_employees.extra_tax_withheld IS
  'The part of tax_withheld that is the employee''s requested förhöjt skatteavdrag (SFL 11 kap. 22 §), frozen at calculation. tax_withheld already includes it. 0 when none was requested or it did not apply.';

NOTIFY pgrst, 'reload schema';
