-- Semesterlöneskuld booked at its day-valued amount (vacation liability
-- remeasurement).
-- pg-test: tests/pg/vacation-liability-remeasure.pg.test.ts
--
-- Until now every salary run booked a per-run accrual on 2920/2940 that was
-- never relieved when vacation was taken; the balance reached the day-valued
-- liability only at the semesterårsavslut. Three changes let a company book
-- the liability as it stands instead:
--
--   1. company_settings.salary_vacation_liability_method: 'accrual' (the
--      default and the historical behaviour, so no existing company changes)
--      or 'remeasure': a run's vacation verifikat is the difference between
--      the computed liability after the run and what 2920/2940 hold.
--   2. salary_calculation_policy gains vacation_day_value, the value of one
--      paid day under sammalöneregeln: 'daily_divisor' (månadslön / 21 at a
--      five-day week, the historical value) or 'percent_4_6' (4,6 % of the
--      månadslön, K2 exempel 17 b). The CHECK below is the 20260919120100 one
--      plus this key; omitted keys still mean the default.
--   3. vacation_liability_remeasurements: the frozen per-employee calculation
--      behind each remeasurement verifikat. It is the underlag of that
--      verifikat (BFL 5 kap 7 §, kept 7 years per BFL 7 kap), so like
--      vacation_year_closures there is no DELETE policy.

-- 1. The booking method.
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_vacation_liability_method text NOT NULL DEFAULT 'accrual';

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_salary_vacation_liability_method_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_salary_vacation_liability_method_check
  CHECK (salary_vacation_liability_method IN ('accrual', 'remeasure'));

COMMENT ON COLUMN public.company_settings.salary_vacation_liability_method IS
  'How semesterlöneskuld (2920/2940) is booked: accrual = per-run accrual, trued up at the semesterårsavslut (historical); remeasure = every booked run (and the standalone reconcile) books the difference to the computed liability. Snapshotted into salary_runs.calculation_params at calculate.';

-- 2. The calculation policy gains vacation_day_value.
ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_salary_calculation_policy_check;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_salary_calculation_policy_check
  CHECK (
    jsonb_typeof(salary_calculation_policy) = 'object'
    AND salary_calculation_policy - ARRAY[
      'partial_month', 'sick_rate', 'long_leave', 'leave_context', 'net_rounding', 'one_off_tax_rounding',
      'vacation_day_value'
    ] = '{}'::jsonb
    AND coalesce(salary_calculation_policy ->> 'partial_month' IN ('workdays', 'annual_calendar_days'), true)
    AND coalesce(salary_calculation_policy ->> 'sick_rate' IN ('daily_divisor', 'annual_hourly'), true)
    AND coalesce(salary_calculation_policy ->> 'long_leave' IN ('workdays', 'calendar_after_five_workdays'), true)
    AND coalesce(salary_calculation_policy ->> 'leave_context' IN ('all_registered', 'through_deviation_end'), true)
    AND coalesce(salary_calculation_policy ->> 'net_rounding' IN ('up', 'nearest'), true)
    AND coalesce(salary_calculation_policy ->> 'one_off_tax_rounding' IN ('truncate', 'nearest'), true)
    AND coalesce(salary_calculation_policy ->> 'vacation_day_value' IN ('daily_divisor', 'percent_4_6'), true)
  );

COMMENT ON COLUMN public.company_settings.salary_calculation_policy IS
  'Payroll calculation conventions (beräkningsprinciper): partial_month, sick_rate, long_leave, leave_context, net_rounding, one_off_tax_rounding, vacation_day_value. {} = every default = the historical engine. Validated by SalaryCalculationPolicySchema and snapshotted into salary_runs.calculation_params at calculate.';

-- 3. The frozen calculation behind each remeasurement.
CREATE TABLE public.vacation_liability_remeasurements (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The date the liability is valued at, the verifikat date: a run's
  -- payment date, or the date chosen for a standalone reconcile.
  as_of_date       date NOT NULL,
  kind             text NOT NULL CHECK (kind IN ('salary_run', 'standalone', 'method_switch')),
  -- The run whose vacation verifikat this is (kind salary_run only). One row
  -- per run: a booking retried after an interruption rewrites its own row.
  salary_run_id    uuid REFERENCES public.salary_runs(id) ON DELETE CASCADE,
  -- The verifikat, when the difference was large enough to book.
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  -- Per employee: days, day value, computed liability and avgifter, the
  -- booked figures before, and the difference booked.
  report           jsonb NOT NULL CHECK (jsonb_typeof(report) = 'object'),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vacation_liability_remeasurements_run_kind
    CHECK ((kind = 'salary_run') = (salary_run_id IS NOT NULL)),
  CONSTRAINT vacation_liability_remeasurements_run_unique UNIQUE (salary_run_id)
);

CREATE INDEX idx_vacation_liability_remeasurements_company_date
  ON public.vacation_liability_remeasurements (company_id, as_of_date);
CREATE INDEX idx_vacation_liability_remeasurements_journal_entry
  ON public.vacation_liability_remeasurements (journal_entry_id);

ALTER TABLE public.vacation_liability_remeasurements ENABLE ROW LEVEL SECURITY;

-- No DELETE policy: the rows are underlag of posted verifikationer.
CREATE POLICY "vacation_liability_remeasurements_select" ON public.vacation_liability_remeasurements
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "vacation_liability_remeasurements_insert" ON public.vacation_liability_remeasurements
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "vacation_liability_remeasurements_update" ON public.vacation_liability_remeasurements
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER vacation_liability_remeasurements_updated_at
  BEFORE UPDATE ON public.vacation_liability_remeasurements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

GRANT SELECT, INSERT, UPDATE ON TABLE public.vacation_liability_remeasurements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.vacation_liability_remeasurements TO service_role;
-- no-grant: anon on public.vacation_liability_remeasurements (company payroll data)

NOTIFY pgrst, 'reload schema';
