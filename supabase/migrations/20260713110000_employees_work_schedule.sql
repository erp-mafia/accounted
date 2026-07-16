-- Migration: employees work schedule (arbetsschema-lite, payroll gap-closure
-- Phase 4).
--
-- The salary engine has hardcoded 40h/5d assumptions: monthly -> hourly uses
-- divisor 173 (52w x 40h / 12m, CBA convention) and daily rates use divisor
-- 21 (52w x 5d / 12m, rounded). For part-time schedules both are wrong: a
-- 4-day/32-hour employee's sick/VAB deduction should divide by ~17.33, not
-- 21. These two columns parametrize the divisors via
-- lib/salary/work-schedule.ts.
--
-- Precedence: employment_degree keeps prorating BASE SALARY;
-- hours_per_week/workdays_per_week ONLY drive the divisors. They can encode
-- overlapping facts (75% degree vs 30h week); the engine deliberately does
-- not reconcile them.
--
-- Backward compatibility: the helpers return the LEGACY constants (173, 21)
-- exactly when the values equal the defaults, so every existing employee's
-- pay math is byte-identical after this migration.

ALTER TABLE public.employees
  ADD COLUMN hours_per_week numeric NOT NULL DEFAULT 40
    CHECK (hours_per_week > 0 AND hours_per_week <= 80),
  ADD COLUMN workdays_per_week numeric NOT NULL DEFAULT 5
    CHECK (workdays_per_week >= 1 AND workdays_per_week <= 7);

NOTIFY pgrst, 'reload schema';
