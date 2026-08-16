-- PR #1588 briefly allowed purchase accounts to store revenue-side treatment
-- names. Preserve the supported non-EU service meaning and clear the
-- unsupported import-goods value before the class-aware constraint is added.
UPDATE public.chart_of_accounts
SET default_vat_treatment = 'reverse_charge_non_eu_services'
WHERE account_class BETWEEN 4 AND 6
  AND default_vat_treatment = 'export_services';

UPDATE public.chart_of_accounts
SET default_vat_treatment = NULL
WHERE account_class BETWEEN 4 AND 6
  AND default_vat_treatment = 'export_goods';
