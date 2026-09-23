-- Momspliktiga uttag (ruta 06) and beskattningsunderlag vid import (ruta 50).
--
-- Both boxes already existed in the declaration type, the eSKD field map
-- (UttagMoms, MomsUlagImport) and the Skatteverket submission mapper, and both
-- were filled structurally: ACCOUNT_RUTA carries 3401/3402/3403 to ruta 06 and
-- 4545/4546/4547 to ruta 50. Those are the only numbers it knows, so a chart
-- that books an uttag or an import basis on any other account dropped the
-- amount out of the declaration in silence, with no box and no warning.
--
-- One treatment each, resolved by account class like the rest:
--   own_use       class 3     -> ruta 06
--   import_goods  class 4-6   -> ruta 50
--
-- Neither carries its own sats: both boxes exist at 25, 12 and 6 %, so the
-- rate comes from the account label or the source system's chart code
-- (vatRateComesFromLabel). The output VAT is unaffected and still reaches the
-- declaration by account number: 2612/2622/2632 to ruta 10-12 for uttag,
-- 2615/2625/2635 to ruta 60-62 for import. The resolver lives in
-- lib/vat/account-vat-treatment.ts.
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
        'vmb', 'rental_voluntary', 'oss', 'triangulation_eu_goods',
        'own_use'
      )
    )
    OR (
      account_class BETWEEN 4 AND 6
      AND default_vat_treatment IN (
        'reverse_charge_domestic', 'reverse_charge_eu_goods',
        'reverse_charge_eu_services', 'reverse_charge_non_eu_services',
        'triangulation_eu_goods', 'import_goods'
      )
    )
  ) NOT VALID;

-- Superset of the previous constraint: validation cannot fail on existing rows.
ALTER TABLE public.chart_of_accounts
  VALIDATE CONSTRAINT chart_of_accounts_default_vat_treatment_check;

COMMENT ON COLUMN public.chart_of_accounts.default_vat_treatment IS
  'Per-account momsdeklaration treatment. Explicit values override the built-in BAS account mapping; ''oss'' keeps revenue out of the Swedish declaration (declared in OSS), ''triangulation_eu_goods'' files ruta 38 on revenue and ruta 37 on purchases, ''own_use'' files ruta 06 and ''import_goods'' ruta 50.';

NOTIFY pgrst, 'reload schema';
