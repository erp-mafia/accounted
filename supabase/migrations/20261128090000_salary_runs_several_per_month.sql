-- Several ordinary salary runs in one month, for the companies listed in
-- SALARY_EXTRA_RUNS_COMPANY_IDS (lib/env/salary-extra-runs-switch.ts).
-- pg-test: tests/pg/salary-runs-several-per-month.pg.test.ts
--
-- A company that pays hourly staff early in the month and monthly staff on
-- the 26th needs two runs whose pay lands in the same payout month. Until now
-- the partial unique index allowed one live run per (company, period).
--
-- run_number numbers the live runs of one period: 1 is the ordinary run, as
-- every run so far; 2 and up are the extra runs the app creates for a listed
-- company. The index now holds one live run per (company, period,
-- run_number), so a company the app never gives a second number keeps
-- exactly the old guarantee. A correction run takes the number of the run it
-- corrects, which is 'corrected' and so out of the index.
--
-- agi_declarations.salary_run_ids lists the runs whose pay a declaration
-- covers when the month's declaration is summed over several runs. NULL, as
-- on every declaration so far, means the declaration covers salary_run_id
-- alone. The kvittens stamps every run listed, and the tax payment reads it
-- to see that the declaration covers every run of its month.

ALTER TABLE public.salary_runs
  ADD COLUMN IF NOT EXISTS run_number smallint NOT NULL DEFAULT 1;

ALTER TABLE public.salary_runs
  DROP CONSTRAINT IF EXISTS salary_runs_run_number_check;
ALTER TABLE public.salary_runs
  ADD CONSTRAINT salary_runs_run_number_check CHECK (run_number >= 1);

DROP INDEX IF EXISTS public.idx_salary_runs_period_unique;
CREATE UNIQUE INDEX idx_salary_runs_period_unique
  ON public.salary_runs (company_id, period_year, period_month, run_number)
  WHERE status <> 'corrected';

ALTER TABLE public.agi_declarations
  ADD COLUMN IF NOT EXISTS salary_run_ids uuid[];

NOTIFY pgrst, 'reload schema';
