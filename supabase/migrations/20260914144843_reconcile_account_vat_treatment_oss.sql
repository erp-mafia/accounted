-- Some staging schemas retained the pre-OSS constraint despite recording
-- 20260822093000 as applied. Restore that contract without changing schemas
-- that already support OSS or touching account values and journal entries.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.chart_of_accounts'::regclass
      AND conname = 'chart_of_accounts_default_vat_treatment_check'
      AND convalidated
      AND position('''oss''::text' IN pg_get_constraintdef(oid)) > 0
  ) THEN
    RETURN;
  END IF;

  ALTER TABLE public.chart_of_accounts
    DROP CONSTRAINT IF EXISTS chart_of_accounts_default_vat_treatment_check;
  ALTER TABLE public.chart_of_accounts
    ADD CONSTRAINT chart_of_accounts_default_vat_treatment_check
    CHECK (
      default_vat_treatment IS NULL
      OR (
        account_class = 3
        AND default_vat_treatment IN (
          'standard_25', 'reduced_12', 'reduced_6', 'exempt',
          'reverse_charge_domestic', 'reverse_charge_eu_goods',
          'reverse_charge_eu_services', 'export_goods', 'export_services',
          'vmb', 'rental_voluntary', 'oss'
        )
      )
      OR (
        account_class BETWEEN 4 AND 6
        AND default_vat_treatment IN (
          'reverse_charge_domestic', 'reverse_charge_eu_goods',
          'reverse_charge_eu_services', 'reverse_charge_non_eu_services'
        )
      )
    ) NOT VALID;
  ALTER TABLE public.chart_of_accounts
    VALIDATE CONSTRAINT chart_of_accounts_default_vat_treatment_check;
  COMMENT ON COLUMN public.chart_of_accounts.default_vat_treatment IS
    'Per-account momsdeklaration treatment. Explicit values override the built-in BAS account mapping; ''oss'' keeps revenue out of the Swedish declaration (declared in OSS).';
END;
$$;

NOTIFY pgrst, 'reload schema';
