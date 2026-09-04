-- A booked salary run is evidence that the company pays salaries (support
-- case 2026-09-04: the assistant told a payroll-running aktiebolag in every
-- answer that it "betalar inte löner").
--
-- company_settings.pays_salaries is NOT NULL DEFAULT false and its only
-- writer is the Skatt settings form, so for every company that never opened
-- that form the flag reads false regardless of what the ledger says, while
-- the app itself books the salary verifikat. The flag feeds the assistant's
-- profile block, the composer, the MCP company resource, the Personal menu
-- for enskild firma and (as the fallback for employer_registered) the AGI
-- deadline reminders, so the stale default is visible in five places.
--
-- 20260717151000 already treated in-app payroll as employer evidence once,
-- as a one-off backfill of employer_registered from salary_runs. This makes
-- the same rule continuous and extends it to pays_salaries, at the one place
-- every writer (dashboard, MCP executor, v1 API, seeders) passes through:
-- the run flipping to 'booked'.
--
-- employer_registered is only filled when NULL (never attested): an explicit
-- false is the user's own answer and stays theirs. SECURITY DEFINER because
-- company_settings_update requires company admin, while any member with
-- write access can book payroll; the function touches only the booking
-- company's own row, and Postgres refuses to call a trigger function
-- directly, so it is not reachable through the API.
-- pg-test: covered-by tests/pg/salary-run-booked-marks-employer.pg.test.ts

CREATE OR REPLACE FUNCTION public.mark_company_pays_salaries_on_booked_run()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  UPDATE public.company_settings
  SET pays_salaries = true,
      employer_registered = COALESCE(employer_registered, true)
  WHERE company_id = NEW.company_id
    AND (pays_salaries = false OR employer_registered IS NULL);
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS salary_runs_booked_marks_employer ON public.salary_runs;
CREATE TRIGGER salary_runs_booked_marks_employer
  AFTER INSERT OR UPDATE OF status ON public.salary_runs
  FOR EACH ROW
  WHEN (NEW.status = 'booked')
  EXECUTE FUNCTION public.mark_company_pays_salaries_on_booked_run();

-- Backfill: companies that already booked payroll in the app. Archived
-- migration-reset sources are skipped: block_migration_reset_source_mutation()
-- makes their rows immutable and would abort the migration.
UPDATE public.company_settings cs
SET pays_salaries = true,
    employer_registered = COALESCE(cs.employer_registered, true)
FROM (SELECT DISTINCT company_id FROM public.salary_runs WHERE status = 'booked') sr
WHERE sr.company_id = cs.company_id
  AND (cs.pays_salaries = false OR cs.employer_registered IS NULL)
  AND cs.company_id NOT IN (
    SELECT source_company_id FROM public.company_migration_resets
  );
