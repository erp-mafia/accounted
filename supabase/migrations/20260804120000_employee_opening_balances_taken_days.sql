-- Migration: employee_opening_balances.vacation_days_taken_this_year
-- (issue #1347: opening balances could not record already-taken days).
--
-- A company switching to Accounted mid-year may have paid vacation days
-- already taken in the current vacation year under the previous payroll
-- system. Those days are invisible to the ledger sync, which re-derives
-- taken_days purely from BOOKED Accounted runs, so the cutover-year row
-- understated both entitled and taken.
--
-- Ledger semantics for the vacation year containing cutover_date:
--   entitled_days = vacation_paid_days_remaining + vacation_days_taken_this_year
--   taken_days    = taken in booked runs + vacation_days_taken_this_year
-- vacation_paid_days_remaining keeps meaning "remaining at cutover"
-- (backward compatible: the public v1 REST API already exposes it).
--
-- The column rides the existing enforce_opening_balances_lock trigger:
-- editable until the employee appears in a booked salary run.

ALTER TABLE public.employee_opening_balances
  ADD COLUMN vacation_days_taken_this_year NUMERIC NOT NULL DEFAULT 0
    CHECK (vacation_days_taken_this_year >= 0 AND vacation_days_taken_this_year <= 40);

NOTIFY pgrst, 'reload schema';
