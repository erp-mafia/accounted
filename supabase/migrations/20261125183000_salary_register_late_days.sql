-- Late days in the absence and worked-days registers.
--
-- A register day (sjukdag, VAB, föräldraledighet, arbetade timmar) belongs
-- to the salary run whose avvikelseperiod holds its date. When the day
-- becomes known only after that run was paid or its arbetsgivardeklaration
-- filed, the run cannot take it any more: its pay is out and its
-- frånvarouppgifter can only be filed with the period's first declaration
-- (Skatteverket, Teknisk beskrivning 1.1.18.2, 9.3). Such a day is settled
-- by a later run instead: the later pay is reduced (kvittning, Skatteverket
-- "Rätta en arbetsgivardeklaration"), and the frånvarouppgift goes in the
-- declaration of the period whose pay the absence affects (TB 1.1.18.2,
-- 5.6; lag 2024:1300 2-3 §§).
--
-- carried_to_run_id names that later run. NULL, every row before this
-- migration, keeps the old meaning: the run whose window holds the date
-- reads the row. A row with a value is read by the named run (and by a
-- correction of it) and by no window. The application decides when a day may
-- be carried (lib/salary/register-locks.ts); the database keeps the link
-- inside the company and refuses to delete a run late days still point at.
--
-- The foreign key is composite, so a row can only point at a run of its own
-- company (salary_runs_id_company_id_key, 20261027100000), and NO ACTION, so
-- deleting a draft run that late days are carried to is refused: the days
-- would be deducted by no run. MATCH SIMPLE: a NULL carried_to_run_id is
-- never checked.

ALTER TABLE public.salary_absence_days
  ADD COLUMN IF NOT EXISTS carried_to_run_id uuid;

ALTER TABLE public.salary_worked_days
  ADD COLUMN IF NOT EXISTS carried_to_run_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_absence_days_carried_to_run_fkey') THEN
    ALTER TABLE public.salary_absence_days
      ADD CONSTRAINT salary_absence_days_carried_to_run_fkey
        FOREIGN KEY (carried_to_run_id, company_id)
        REFERENCES public.salary_runs (id, company_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'salary_worked_days_carried_to_run_fkey') THEN
    ALTER TABLE public.salary_worked_days
      ADD CONSTRAINT salary_worked_days_carried_to_run_fkey
        FOREIGN KEY (carried_to_run_id, company_id)
        REFERENCES public.salary_runs (id, company_id);
  END IF;
END $$;

-- The calculation and the AGI read a run's late days by this column.
CREATE INDEX IF NOT EXISTS idx_salary_absence_days_carried_to_run
  ON public.salary_absence_days (carried_to_run_id)
  WHERE carried_to_run_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_salary_worked_days_carried_to_run
  ON public.salary_worked_days (carried_to_run_id)
  WHERE carried_to_run_id IS NOT NULL;

COMMENT ON COLUMN public.salary_absence_days.carried_to_run_id IS
  'The later salary run that settles this day because the run whose avvikelseperiod holds the date was already paid or declared. NULL: the run whose window holds the date reads it.';

COMMENT ON COLUMN public.salary_worked_days.carried_to_run_id IS
  'The later salary run that pays these hours because the run whose avvikelseperiod holds the date was already paid or declared. NULL: the run whose window holds the date reads it.';

NOTIFY pgrst, 'reload schema';
