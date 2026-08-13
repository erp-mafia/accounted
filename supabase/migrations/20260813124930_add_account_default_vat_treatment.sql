ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS default_vat_treatment text;

ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_default_vat_treatment_check;

ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_default_vat_treatment_check
  CHECK (default_vat_treatment IS NULL OR default_vat_treatment IN (
    'standard_25', 'reduced_12', 'reduced_6', 'exempt',
    'reverse_charge_domestic', 'reverse_charge_eu_goods',
    'reverse_charge_eu_services', 'export_goods', 'export_services',
    'vmb', 'rental_voluntary'
  ));

COMMENT ON COLUMN public.chart_of_accounts.default_vat_treatment IS
  'Per-account momsdeklaration treatment. Explicit values override the built-in BAS account mapping.';

NOTIFY pgrst, 'reload schema';
