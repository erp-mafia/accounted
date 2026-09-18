ALTER TABLE public.company_settings
  ADD COLUMN salary_calculation_policy jsonb NOT NULL DEFAULT '{}'::jsonb
  CHECK (jsonb_typeof(salary_calculation_policy) = 'object');
COMMENT ON COLUMN public.company_settings.salary_calculation_policy IS
  'Explicit employer conventions, validated by SalaryCalculationPolicySchema and snapshotted at calculation.';
NOTIFY pgrst, 'reload schema';
