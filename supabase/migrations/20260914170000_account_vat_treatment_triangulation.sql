-- Trepartshandel (triangulation): A sells to B sells to C across three EU
-- countries while the goods move directly from A to C. The middleman B avoids
-- registering for VAT in the destination country and instead declares the
-- purchase in ruta 37 and the onward sale in ruta 38, with no output or input
-- VAT on either, plus the amounts in periodisk sammanställning under the
-- trepartshandel column (ML 5 kap. 22-25 §; standard BAS 4512 and 3107).
--
-- Both rutor existed in the declaration type, the eSKD field map and the
-- periodisk sammanställning reconciliation, but nothing could ever put a value
-- in them: no account treatment resolved to 37 or 38 and neither BAS account
-- was mapped, so every declaration filed them as zero. One treatment covers
-- both sides, resolved by account class, exactly as reverse_charge_eu_goods
-- already is. The resolver lives in lib/vat/account-vat-treatment.ts.
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
        'vmb', 'rental_voluntary', 'oss', 'triangulation_eu_goods'
      )
    )
    OR (
      account_class BETWEEN 4 AND 6
      AND default_vat_treatment IN (
        'reverse_charge_domestic', 'reverse_charge_eu_goods',
        'reverse_charge_eu_services', 'reverse_charge_non_eu_services',
        'triangulation_eu_goods'
      )
    )
  ) NOT VALID;

-- Superset of the previous constraint: validation cannot fail on existing rows.
ALTER TABLE public.chart_of_accounts
  VALIDATE CONSTRAINT chart_of_accounts_default_vat_treatment_check;

COMMENT ON COLUMN public.chart_of_accounts.default_vat_treatment IS
  'Per-account momsdeklaration treatment. Explicit values override the built-in BAS account mapping; ''oss'' keeps revenue out of the Swedish declaration (declared in OSS), ''triangulation_eu_goods'' files ruta 38 on revenue and ruta 37 on purchases.';

NOTIFY pgrst, 'reload schema';
