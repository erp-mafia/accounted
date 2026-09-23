-- Payroll cutover: categorized vacation balances on the flat opening-balance
-- model (cutover track of #2729, Frey / Fortnox and Azets takeovers).
-- pg-test: supabase/migrations/__tests__/employee-opening-balances-categories.pg.test.ts
--
-- Why: an operator taking over a customer mid-year loads each employee's
-- vacation state from the previous system. Fortnox and Azets keep five
-- day categories (Betalda, Sparade per år, Obetalda, Förskott, Extra
-- betalda) and a förskottsskuld in SEK; the flat model only carried paid
-- days remaining and sparade dagar. The categories are EXTENDED onto the
-- existing row as plain numeric columns so a row written before this
-- migration reads exactly as it did (every new pool defaults to 0, the
-- as-of date to NULL = the day before cutover_date).
--
--   vacation_as_of_date              the day the vacation balances are "per".
--                                    NULL = the day before cutover_date. With
--                                    avvikelseperiod previous_month the first
--                                    Accounted run consumes LAST month's leave,
--                                    so a balance the old system struck before
--                                    that month must say so here or the ledger
--                                    would skip those days as already deducted.
--   vacation_unpaid_days_remaining   Obetalda: unpaid days left this year
--                                    (Semesterlagen 8 §); lapse at year close.
--   vacation_advance_days_remaining  Förskott: förskottssemester days granted
--                                    but not yet taken.
--   vacation_extra_paid_days_remaining
--                                    Extra betalda: paid days above the
--                                    statutory entitlement (kollektivavtal or
--                                    contract); part of the paid pool for the
--                                    intjänandeår.
--   opening_advance_vacation_debt    Förskottsskuld in SEK (Semesterlagen
--                                    29 a §, deductible at termination within
--                                    five years, then written off). Report
--                                    only, like the opening semesterlöneskuld.
--
-- ytd_net becomes NULLABLE on both the opening row and the payslip snapshot:
-- a previous system that cannot export historical net pay leaves it
-- unknown, and the payslip prints "Underlag saknas" for the accumulator
-- instead of a false 0. Never infer net from gross minus tax.
--
-- employee_vacation_balances gains the unpaid and advance pools (remaining
-- days, recomputed by the ledger sync) and saved_days_taken (days consumed
-- from each origin year by 'saved' payslip lines, recomputed from booked
-- runs). saved_days keeps its meaning as the year's seeded sparade dagar so
-- every existing row reads unchanged; remaining = saved_days - saved_days_taken.
--
-- The derived lock trigger (enforce_opening_balances_lock, migration
-- 20260713101000) fires BEFORE INSERT OR UPDATE on the whole row, so the
-- new columns are locked by the first booked run without any change here.

ALTER TABLE public.employee_opening_balances
  ADD COLUMN IF NOT EXISTS vacation_as_of_date DATE NULL,
  ADD COLUMN IF NOT EXISTS vacation_unpaid_days_remaining NUMERIC NOT NULL DEFAULT 0
    CHECK (vacation_unpaid_days_remaining >= 0 AND vacation_unpaid_days_remaining <= 40),
  ADD COLUMN IF NOT EXISTS vacation_advance_days_remaining NUMERIC NOT NULL DEFAULT 0
    CHECK (vacation_advance_days_remaining >= 0 AND vacation_advance_days_remaining <= 40),
  ADD COLUMN IF NOT EXISTS vacation_extra_paid_days_remaining NUMERIC NOT NULL DEFAULT 0
    CHECK (vacation_extra_paid_days_remaining >= 0 AND vacation_extra_paid_days_remaining <= 40),
  ADD COLUMN IF NOT EXISTS opening_advance_vacation_debt NUMERIC NOT NULL DEFAULT 0
    CHECK (opening_advance_vacation_debt >= 0);

ALTER TABLE public.employee_opening_balances
  ALTER COLUMN ytd_net DROP NOT NULL;

ALTER TABLE public.salary_run_employees
  ALTER COLUMN ytd_net DROP NOT NULL;

ALTER TABLE public.employee_vacation_balances
  ADD COLUMN IF NOT EXISTS unpaid_days NUMERIC NOT NULL DEFAULT 0
    CHECK (unpaid_days >= 0),
  ADD COLUMN IF NOT EXISTS advance_days NUMERIC NOT NULL DEFAULT 0
    CHECK (advance_days >= 0),
  ADD COLUMN IF NOT EXISTS saved_days_taken JSONB NOT NULL DEFAULT '{}'
    CHECK (jsonb_typeof(saved_days_taken) = 'object');

COMMENT ON COLUMN public.employee_opening_balances.vacation_as_of_date IS
  'The day the vacation balances are struck per. NULL = the day before cutover_date. Booked runs whose avvikelseperiod ends on or before this day are already inside the balance and are not deducted again.';
COMMENT ON COLUMN public.employee_opening_balances.vacation_unpaid_days_remaining IS
  'Obetalda semesterdagar left this vacation year at the as-of date (Fortnox/Azets: Obetalda). Lapse at year close.';
COMMENT ON COLUMN public.employee_opening_balances.vacation_advance_days_remaining IS
  'Förskottssemester days granted but not yet taken at the as-of date (Fortnox/Azets: Förskott).';
COMMENT ON COLUMN public.employee_opening_balances.vacation_extra_paid_days_remaining IS
  'Paid days above the statutory entitlement left this vacation year (Fortnox/Azets: Extra betalda). Counted into the paid pool.';
COMMENT ON COLUMN public.employee_opening_balances.opening_advance_vacation_debt IS
  'Förskottsskuld in SEK at cutover (Semesterlagen 29 a §). Report only: shown as its own row on the vacation-liability report and subtracted from the net liability. Never booked by Accounted.';
COMMENT ON COLUMN public.employee_opening_balances.ytd_net IS
  'YTD net pay before cutover. NULL = unknown (the previous system could not export it); the payslip then prints Underlag saknas. Never infer net from gross minus tax.';
COMMENT ON COLUMN public.salary_run_employees.ytd_net IS
  'Ackumulerat netto snapshot. NULL = unknown because the cutover opening balance had no net; printed as Underlag saknas.';
COMMENT ON COLUMN public.employee_vacation_balances.unpaid_days IS
  'Obetalda days still available this vacation year (cutover pool minus unpaid vacation lines in booked runs). 0 outside the cutover year: unpaid days never carry.';
COMMENT ON COLUMN public.employee_vacation_balances.advance_days IS
  'Förskottssemester days still available (cutover pool minus advance vacation lines in booked runs). 0 outside the cutover year.';
COMMENT ON COLUMN public.employee_vacation_balances.saved_days_taken IS
  'Sparade dagar consumed this vacation year by origin year, recomputed from vacation lines with vacation_category = saved in booked runs. Remaining sparade dagar = saved_days - saved_days_taken per year.';

NOTIFY pgrst, 'reload schema';
