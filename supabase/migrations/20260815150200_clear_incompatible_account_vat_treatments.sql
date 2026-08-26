-- The predecessor API validated enum membership but not account class. After
-- preserving the one lossless legacy rename, clear every remaining invalid
-- combination before the class-aware constraint is installed.
UPDATE public.chart_of_accounts
SET default_vat_treatment = NULL
WHERE default_vat_treatment IS NOT NULL
  AND NOT (
    (
      account_class = 3
      AND default_vat_treatment IN (
        'standard_25', 'reduced_12', 'reduced_6', 'exempt',
        'reverse_charge_domestic', 'reverse_charge_eu_goods',
        'reverse_charge_eu_services', 'export_goods', 'export_services',
        'vmb', 'rental_voluntary'
      )
    )
    OR (
      account_class BETWEEN 4 AND 6
      AND default_vat_treatment IN (
        'reverse_charge_domestic', 'reverse_charge_eu_goods',
        'reverse_charge_eu_services', 'reverse_charge_non_eu_services'
      )
    )
  );
