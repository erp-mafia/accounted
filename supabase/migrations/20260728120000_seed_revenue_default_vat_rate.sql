-- Seed "Standard moms" (chart_of_accounts.default_vat_rate) on the BAS revenue
-- accounts Accounted ships.
--
-- Background (#1261): the momsdeklaration resolves ruta 05 from a fixed BAS
-- whitelist (ACCOUNT_RUTA), which is only right for a company that never
-- touched its kontoplan. Accounted's BAS chart ships no varugrupp accounts, so
-- every 3011/3013/3041-style konto is user-added, and its revenue was never
-- even fetched from the ledger. The fix reads default_vat_rate on class 3
-- accounts instead, which makes the field the answer to "is this momspliktig
-- forsaljning, and at what sats?".
--
-- That only works if the field is populated. 3001/3002/3003 shipped with an
-- empty "Standard moms" even though their whole identity is the moms-sats in
-- their name, which reads as "no rate set" in the account dialogs and made the
-- new rule look arbitrary. This seeds the four accounts whose sats is not a
-- judgement call.
--
-- No declaration figure changes: fetchDynamicRuta05Accounts excludes every
-- account already mapped in ACCOUNT_TO_BOX (a superset of ACCOUNT_RUTA), so
-- 3001-3004 keep coming from the static map and are not counted twice.
--
-- pg-test: supabase/migrations/__tests__/account-default-vat-rate.pg.test.ts

-- Existing companies. Only rows without an explicit value: a user who
-- deliberately set something else keeps it.
UPDATE public.chart_of_accounts SET default_vat_rate = 0.25
  WHERE account_number = '3001' AND default_vat_rate IS NULL;
UPDATE public.chart_of_accounts SET default_vat_rate = 0.12
  WHERE account_number = '3002' AND default_vat_rate IS NULL;
UPDATE public.chart_of_accounts SET default_vat_rate = 0.06
  WHERE account_number = '3003' AND default_vat_rate IS NULL;
UPDATE public.chart_of_accounts SET default_vat_rate = 0
  WHERE account_number = '3004' AND default_vat_rate IS NULL;

-- New / imported / on-demand rows. Widens the BEFORE INSERT default introduced
-- for 3740 in 20260709120000: seed_chart_of_accounts() does not write a VAT
-- column, so the trigger is still the one place that covers every insert path
-- (company seed, SIE import, on-demand backfill, manual add). Fires only when
-- the caller left the rate unset, so an explicit choice always wins.
--
-- Replaces set_known_momsfri_default_vat_rate(): the name stopped being true
-- once the map carries momspliktiga sats as well.
CREATE OR REPLACE FUNCTION public.set_known_default_vat_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.default_vat_rate IS NULL THEN
    NEW.default_vat_rate := CASE NEW.account_number
      WHEN '3001' THEN 0.25
      WHEN '3002' THEN 0.12
      WHEN '3003' THEN 0.06
      WHEN '3004' THEN 0     -- momsfri forsaljning
      WHEN '3740' THEN 0     -- oresavrundning, never carries moms
      ELSE NULL
    END;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chart_of_accounts_momsfri_default ON public.chart_of_accounts;
DROP TRIGGER IF EXISTS trg_chart_of_accounts_default_vat_rate ON public.chart_of_accounts;
CREATE TRIGGER trg_chart_of_accounts_default_vat_rate
  BEFORE INSERT ON public.chart_of_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_known_default_vat_rate();

DROP FUNCTION IF EXISTS public.set_known_momsfri_default_vat_rate();

COMMENT ON COLUMN public.chart_of_accounts.default_vat_rate IS
  'Per-account default VAT rate for booking lines (0/0.06/0.12/0.25). NULL = no default. On class 3 accounts it also decides whether the konto counts as momspliktig forsaljning in ruta 05 of the momsdeklaration (see lib/reports/vat-revenue-accounts.ts).';

NOTIFY pgrst, 'reload schema';
