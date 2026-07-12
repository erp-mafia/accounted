-- Salary settings P1: pain.001 becomes the default payment format, plus
-- persisted payroll settings (pay day, default bank).
--
-- Background (dev_docs/payroll-benchmark-2026.md): the Swedish bank
-- infrastructure retires Bankgirot Lön (LB) bank-by-bank during 2026
-- (Swedbank ends "Lön via Bankgirot" 2026-08-01; Handelsbanken stopped
-- accepting salary files to Bankgirot after 2026-05-31). ISO 20022 pain.001
-- is the replacement and is already implemented.
--
-- This migration:
--   1. Flips the column default for preferred_payment_format to 'pain001'.
--   2. Conditionally backfills existing companies: only those that have
--      NEVER generated an LB file are flipped (the old 'bg_lb' default was
--      applied blindly by 20260508120000 and encodes no preference for
--      them). Companies with a working LB routine keep 'bg_lb' and get an
--      in-product sunset warning instead.
--   3. Adds company_settings.salary_pay_day (day of month salaries are paid;
--      drives run-creation defaults and the salary dashboard).
--   4. Adds company_settings.salary_default_bank (pre-selects bank upload
--      instructions for payment files).

-- ------------------------------------------------------------------
-- 1. New default
-- ------------------------------------------------------------------
ALTER TABLE public.company_settings
  ALTER COLUMN preferred_payment_format SET DEFAULT 'pain001';

-- ------------------------------------------------------------------
-- 2. Conditional backfill (idempotent)
-- ------------------------------------------------------------------
UPDATE public.company_settings cs
  SET preferred_payment_format = 'pain001'
  WHERE cs.preferred_payment_format = 'bg_lb'
    AND NOT EXISTS (
      SELECT 1 FROM public.salary_runs sr
      WHERE sr.company_id = cs.company_id
        AND sr.payment_file_format = 'bg_lb'
    );

-- ------------------------------------------------------------------
-- 3. salary_pay_day
-- ------------------------------------------------------------------
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_pay_day integer NOT NULL DEFAULT 25;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_salary_pay_day_check;

-- 1–28 so the configured day exists in every month (February included).
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_salary_pay_day_check
  CHECK (salary_pay_day BETWEEN 1 AND 28);

-- ------------------------------------------------------------------
-- 4. salary_default_bank
-- ------------------------------------------------------------------
ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_default_bank text;

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_salary_default_bank_check;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_salary_default_bank_check
  CHECK (
    salary_default_bank IS NULL
    OR salary_default_bank IN ('swedbank', 'seb', 'handelsbanken', 'nordea', 'other')
  );

-- Reload PostgREST schema cache.
NOTIFY pgrst, 'reload schema';
