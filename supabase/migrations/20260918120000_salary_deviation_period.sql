-- Salary deviation period (avvikelseperiod).
--
-- Swedish payroll commonly pays the fixed monthly salary for the current
-- month while the deviations (frånvaro, sjuklön, VAB, worked hours for
-- hourly staff, OB) are taken from the PREVIOUS month, because the calendar
-- for the current month is not known on pay day. Fortnox and Visma call
-- this "avvikelseperiod". Until now the engine read every calendar-derived
-- record from the pay month itself, so a company running "föregående
-- månads avvikelser" got no absence lines at all.
--
-- 1. company_settings.salary_deviation_period: the company default for new
--    runs. 'same_month' keeps today's behaviour; 'previous_month' reads the
--    calendar from the month before the pay period.
-- 2. salary_runs.deviation_period_start / deviation_period_end: the window
--    snapshotted on the run at creation (from the setting, or passed
--    explicitly by the API caller). NULL on both = the pay month itself,
--    which is what every existing run means. The calculation engine and the
--    AGI frånvarouppgifter read this window, never the setting, so a later
--    settings change cannot silently move an already-calculated run.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_deviation_period text NOT NULL DEFAULT 'same_month';

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_salary_deviation_period_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_salary_deviation_period_check
  CHECK (salary_deviation_period IN ('same_month', 'previous_month'));

ALTER TABLE public.salary_runs
  ADD COLUMN IF NOT EXISTS deviation_period_start date,
  ADD COLUMN IF NOT EXISTS deviation_period_end date;

ALTER TABLE public.salary_runs
  DROP CONSTRAINT IF EXISTS salary_runs_deviation_period_check;

-- Both bounds or neither, never inverted, and at most two months (62 days
-- inclusive): the same cap lib/salary/deviation-period.ts enforces, so a
-- support script or a direct SQL fix cannot feed sjuklön and AGI a window
-- the application would have refused.
ALTER TABLE public.salary_runs
  ADD CONSTRAINT salary_runs_deviation_period_check
  CHECK (
    (deviation_period_start IS NULL AND deviation_period_end IS NULL)
    OR (
      deviation_period_start IS NOT NULL
      AND deviation_period_end IS NOT NULL
      AND deviation_period_start <= deviation_period_end
      AND deviation_period_end - deviation_period_start <= 61
    )
  );

COMMENT ON COLUMN public.company_settings.salary_deviation_period IS
  'Default avvikelseperiod for new salary runs: same_month (calendar of the pay month) or previous_month (calendar of the month before).';
COMMENT ON COLUMN public.salary_runs.deviation_period_start IS
  'First day of the window the run reads absence and worked days from. NULL = first day of the pay month.';
COMMENT ON COLUMN public.salary_runs.deviation_period_end IS
  'Last day of the window the run reads absence and worked days from. NULL = last day of the pay month.';

NOTIFY pgrst, 'reload schema';
