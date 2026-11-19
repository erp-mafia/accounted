-- Paid semesterdagar per day off, frozen on each payslip.
--
-- Semesterlagen gives every employee 25 paid semesterdagar (4 §) and requires
-- that someone working fewer days a week gets leave as long as a full-timer's
-- (12 a §). A 4-day week therefore takes its 25 paid days as 20 days off: each
-- day off on a vacation line uses 25/20 = 1.25 paid days. The vacation ledger
-- keeps every balance in paid days (saving under 18 §, the year-end payout,
-- the semesterlöneskuld), so it needs the factor each payslip was calculated
-- with: a later change to the employee's workdays must not re-count leave
-- that was already booked.
--
-- Written by the salary run calculation (src/lib/salary/run-calculation.ts).
-- NULL on rows calculated before this column existed: those count one paid
-- day per day off, which is what they were booked with.

ALTER TABLE public.salary_run_employees
  ADD COLUMN vacation_paid_days_per_day_off numeric
    CONSTRAINT salary_run_employees_vacation_paid_days_per_day_off_check
    CHECK (vacation_paid_days_per_day_off > 0);

COMMENT ON COLUMN public.salary_run_employees.vacation_paid_days_per_day_off IS
  'Paid semesterdagar each day off on this payslip''s vacation lines used (Semesterlagen 12 a §): 25/20 = 1.25 for a 4-day week, 1 for five days or more. NULL (rows calculated before 2026-10-12) reads as 1.';

NOTIFY pgrst, 'reload schema';
