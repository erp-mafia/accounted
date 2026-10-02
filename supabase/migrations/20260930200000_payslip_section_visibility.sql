-- Payslip section visibility for the employee copy (lönespecifikation).
--
-- The payslip PDF has always printed two employer-facing sections:
-- Arbetsgivarkostnad (arbetsgivaravgifter, semesteravsättning and the total
-- employer cost) and Beräkningsunderlag (every calculation step the engine
-- took). Neither is required on the employee's lönespecifikation, and some
-- employers do not want them in what the employee receives.
--
-- Two company switches decide whether each section is printed on the copy
-- the EMPLOYEE receives (the emailed payslip link and the API download).
-- The employer's own view of the payslip in the app always prints both.
--
-- DEFAULT true: every existing company keeps exactly the payslip it has
-- today until someone turns a section off.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_payslip_show_employer_cost boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS salary_payslip_show_breakdown boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.company_settings.salary_payslip_show_employer_cost IS
  'Print the Arbetsgivarkostnad section on the payslip the employee receives. The employer view always prints it.';
COMMENT ON COLUMN public.company_settings.salary_payslip_show_breakdown IS
  'Print the Beräkningsunderlag section on the payslip the employee receives. The employer view always prints it.';

-- ---------------------------------------------------------------------------
-- What a run's employee payslips printed when they were issued.
-- pg-test: covered-by tests/pg/salary-run-payslip-sections-snapshot.pg.test.ts
--
-- A payslip is räkenskapsinformation (7-year retention) and BFL 7 kap. 1 §
-- requires electronic räkenskapsinformation to be kept with the content it
-- had when it was compiled. The switches above live on company_settings and
-- can change at any time, so the employee copy of a run that has already
-- reached its employees must not follow them: it keeps the sections it was
-- issued with.
--
-- The first time a run's payslips go to employees (the payslip email, or an
-- employee-copy download such as "Ladda ner alla lönebesked", whichever
-- happens first) the application writes the effective sections here, once.
-- Every employee copy of that run is then rendered from these columns.
-- NULL on all three means not yet issued: the employee copy follows the
-- live switches. The employer's own view always prints both sections.
ALTER TABLE public.salary_runs
  ADD COLUMN IF NOT EXISTS payslip_sections_issued_at timestamptz,
  ADD COLUMN IF NOT EXISTS payslip_show_employer_cost boolean,
  ADD COLUMN IF NOT EXISTS payslip_show_breakdown boolean;

COMMENT ON COLUMN public.salary_runs.payslip_sections_issued_at IS
  'When the payslips of this run first went to employees and their sections were fixed. NULL = not yet issued: the employee copy follows company_settings.';
COMMENT ON COLUMN public.salary_runs.payslip_show_employer_cost IS
  'Whether the employee copy of this run prints Arbetsgivarkostnad, fixed at first issue. NULL = not yet issued.';
COMMENT ON COLUMN public.salary_runs.payslip_show_breakdown IS
  'Whether the employee copy of this run prints Beräkningsunderlag, fixed at first issue. NULL = not yet issued. Never true while payslip_show_employer_cost is false.';

-- Runs whose payslips may already have reached employees before this
-- migration were issued with both sections: every employee copy printed them
-- then, the payslip had no switches. Such a run is marked issued with both
-- sections, so a later switch change cannot alter a payslip already handed
-- out. A run counts as possibly handed out when:
--   - it has a payslip link (created by the send) or a delivery logged as
--     sent, in any status; or
--   - it is paid, booked or corrected. Before this migration the employer
--     could hand those out through "Ladda ner alla lönebesked" or its own
--     view without leaving any trace, so the status is the only evidence.
-- An approved run with neither link nor delivery stays unissued: it is not
-- paid yet, so the company can still hide sections before handing it out.
-- issued_at is the first link or delivery, else the run's last update (the
-- latest moment it can have been handed out as it stands).
-- Runs of an archived migration-reset source are skipped: their rows are
-- immutable (block_migration_reset_source_mutation raises on any UPDATE) and
-- nothing hands out their payslips any more.
-- pg-test: tests/pg/salary-run-payslip-sections-snapshot.pg.test.ts re-runs
-- the statement between the backfill markers.
-- backfill:begin
UPDATE public.salary_runs r
   SET payslip_sections_issued_at = coalesce(
         (SELECT min(evidence.created_at)
            FROM (
              SELECT l.created_at
                FROM public.salary_payslip_links l
               WHERE l.salary_run_id = r.id
              UNION ALL
              SELECT d.created_at
                FROM public.salary_payslip_deliveries d
               WHERE d.salary_run_id = r.id AND d.status = 'sent'
            ) evidence),
         r.updated_at),
       payslip_show_employer_cost = true,
       payslip_show_breakdown = true
 WHERE r.payslip_sections_issued_at IS NULL
   AND (
         r.status IN ('paid', 'booked', 'corrected')
      OR EXISTS (SELECT 1 FROM public.salary_payslip_links l WHERE l.salary_run_id = r.id)
      OR EXISTS (
           SELECT 1 FROM public.salary_payslip_deliveries d
            WHERE d.salary_run_id = r.id AND d.status = 'sent'
         )
   )
   AND NOT EXISTS (
         SELECT 1 FROM public.company_migration_resets m
          WHERE m.source_company_id = r.company_id
   );
-- backfill:end

-- All three set together, and the breakdown never without the employer cost
-- (its steps carry the employer cost figures).
ALTER TABLE public.salary_runs
  DROP CONSTRAINT IF EXISTS salary_runs_payslip_sections_snapshot_shape;
ALTER TABLE public.salary_runs
  ADD CONSTRAINT salary_runs_payslip_sections_snapshot_shape CHECK (
    (payslip_sections_issued_at IS NULL
      AND payslip_show_employer_cost IS NULL
      AND payslip_show_breakdown IS NULL)
    OR (payslip_sections_issued_at IS NOT NULL
      AND payslip_show_employer_cost IS NOT NULL
      AND payslip_show_breakdown IS NOT NULL
      AND (payslip_show_employer_cost OR NOT payslip_show_breakdown))
  );

-- Written once. salary_runs_update lets any company writer PATCH a run, so
-- the database, not only the application, keeps an issued snapshot as it
-- was: once payslip_sections_issued_at is set none of the three columns can
-- change, for any caller.
CREATE OR REPLACE FUNCTION public.salary_runs_payslip_sections_write_once()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF OLD.payslip_sections_issued_at IS NOT NULL AND (
       NEW.payslip_sections_issued_at IS DISTINCT FROM OLD.payslip_sections_issued_at
    OR NEW.payslip_show_employer_cost IS DISTINCT FROM OLD.payslip_show_employer_cost
    OR NEW.payslip_show_breakdown IS DISTINCT FROM OLD.payslip_show_breakdown
  ) THEN
    RAISE EXCEPTION 'The payslip sections of salary run % were fixed when its payslips were issued and cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS salary_runs_payslip_sections_write_once ON public.salary_runs;
CREATE TRIGGER salary_runs_payslip_sections_write_once
  BEFORE UPDATE OF payslip_sections_issued_at, payslip_show_employer_cost, payslip_show_breakdown
  ON public.salary_runs
  FOR EACH ROW
  EXECUTE FUNCTION public.salary_runs_payslip_sections_write_once();

NOTIFY pgrst, 'reload schema';
