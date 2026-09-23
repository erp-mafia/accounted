-- Per-account momsruta for VAT accounts (klass 26).
--
-- The momsdeklaration maps 26xx accounts to their ruta by BAS number. A chart
-- laid out before the 2015 BAS change, or by a source system with its own
-- layout, books the same VAT on other numbers: a Fortnox chart commonly has
-- EU-förvärv on 2615, import on 2616 and tjänster utanför EU on 2617, where
-- BAS reads 2615 as import (ruta 60), 2616 as VMB (ruta 10) and has no 2617.
-- The import keeps the company's numbers (they are its history), so the
-- account carries the ruta it feeds instead.
--
-- null keeps the BAS mapping, a box code routes the balance there. There is
-- no "no box" value on purpose: an opt-out would let a real VAT balance leave
-- the declaration in silence. Only 26xx accounts other than 2650
-- (momsredovisning, which nets the declaration) may carry one. The set
-- mirrors ACCOUNT_VAT_BOXES in lib/vat/account-vat-box.ts.
ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS vat_box text;

ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_vat_box_check;
ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_vat_box_check
  CHECK (
    vat_box IS NULL
    OR (
      account_number ~ '^26[0-9]{2}$'
      AND account_number <> '2650'
      AND vat_box IN (
        '10', '11', '12',
        '30', '31', '32',
        '60', '61', '62',
        '48'
      )
    )
  );

COMMENT ON COLUMN public.chart_of_accounts.vat_box IS
  'Momsruta override for a 26xx VAT account: box code (10-12, 30-32, 60-62, 48), or NULL for the BAS mapping by account number.';

NOTIFY pgrst, 'reload schema';
