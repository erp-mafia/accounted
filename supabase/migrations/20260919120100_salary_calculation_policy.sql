-- Company-level payroll calculation conventions (policy track of #2729).
-- pg-test: supabase/migrations/__tests__/salary-calculation-policy.pg.test.ts
--
-- Swedish law fixes what is paid (sjuklön 80 %, one karensavdrag per
-- sjuklöneperiod, semesterlön); how a monthly salary is turned into a day,
-- an hour or a partial month follows the employment contract and the
-- kollektivavtal. Fortnox, the reference for customers moving to Accounted,
-- uses calendar-day proration (månadslön × 12 / 365), an hourly sick rate
-- (månadslön × 12 / (52 × veckoarbetstid)), calendar-day deduction for leave
-- longer than five working days, and nearest-krona net rounding. Accounted's
-- engine has its own conventions (workday proration, 21-day daily rate, up
-- rounding). This column makes the choice explicit per company.
--
-- jsonb with the six conventions as keys; the empty object is the default and
-- means every convention at its default, which is the engine's historical
-- behaviour, so no existing company changes. The CHECK closes the key set and
-- each value's enum (mirroring SalaryCalculationPolicySchema in
-- lib/salary/calculation-policy.ts) so a support script cannot store a typo
-- that the strict parser would then refuse at every :calculate. Adding a
-- convention means a NEW migration that drops and re-adds this constraint.
--
-- The policy is snapshotted into salary_runs.calculation_params at
-- :calculate (key salary_calculation_policy) so a run keeps the conventions
-- it was calculated with.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_calculation_policy jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_salary_calculation_policy_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_salary_calculation_policy_check
  CHECK (
    jsonb_typeof(salary_calculation_policy) = 'object'
    AND salary_calculation_policy - ARRAY[
      'partial_month', 'sick_rate', 'long_leave', 'leave_context', 'net_rounding', 'one_off_tax_rounding'
    ] = '{}'::jsonb
    AND coalesce(salary_calculation_policy ->> 'partial_month' IN ('workdays', 'annual_calendar_days'), true)
    AND coalesce(salary_calculation_policy ->> 'sick_rate' IN ('daily_divisor', 'annual_hourly'), true)
    AND coalesce(salary_calculation_policy ->> 'long_leave' IN ('workdays', 'calendar_after_five_workdays'), true)
    AND coalesce(salary_calculation_policy ->> 'leave_context' IN ('all_registered', 'through_deviation_end'), true)
    AND coalesce(salary_calculation_policy ->> 'net_rounding' IN ('up', 'nearest'), true)
    AND coalesce(salary_calculation_policy ->> 'one_off_tax_rounding' IN ('truncate', 'nearest'), true)
  );

COMMENT ON COLUMN public.company_settings.salary_calculation_policy IS
  'Payroll calculation conventions (beräkningsprinciper): partial_month, sick_rate, long_leave, leave_context, net_rounding, one_off_tax_rounding. {} = every default = the historical engine. Validated by SalaryCalculationPolicySchema and snapshotted into salary_runs.calculation_params at calculate.';

NOTIFY pgrst, 'reload schema';
