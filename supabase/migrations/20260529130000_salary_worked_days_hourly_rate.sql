-- Migration: salary_worked_days_hourly_rate — optional per-day hourly wage
-- override on manually-entered worked days.
--
-- Why this exists: the payroll calculator derives an hourly employee's base
-- salary as `hourly_rate × Σ hours`, using the single rate stored on the
-- employee record. Some shifts are paid at a different rate (e.g. a one-off
-- higher rate, a stand-in covering another role). This lets the user set the
-- rate to pay out per worked-day entry from the salary calendar.
--
-- Nullable by design: when null, the calculator falls back to the employee's
-- default hourly_rate, so existing rows and the common case are unchanged.
-- The CHECK mirrors the employee rate domain (non-negative monetary value).

ALTER TABLE public.salary_worked_days
  ADD COLUMN hourly_rate NUMERIC(10, 2)
    CHECK (hourly_rate IS NULL OR hourly_rate >= 0);

NOTIFY pgrst, 'reload schema';
