-- Per-account default VAT rate ("Standard moms") on the chart of accounts.
--
-- Lets a company decide, once per konto, which moms-sats a booking line should
-- default to when that konto is picked. The motivating case is oresavrundning
-- (konto 3740, Ores- och kronutjamning): a rounding line must never carry moms,
-- but the leverantorsfaktura-editor defaulted every rad to 25 %, so the moms and
-- the rounding came out wrong. NULL keeps today's behaviour (no auto-fill);
-- 0 = ingen moms. Stored as a decimal fraction to match how the app carries VAT
-- rates everywhere else (0 / 0.06 / 0.12 / 0.25).

ALTER TABLE public.chart_of_accounts
  ADD COLUMN IF NOT EXISTS default_vat_rate numeric;

-- Constrain to the sats the app understands; NULL stays allowed (no default).
ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_default_vat_rate_check;
ALTER TABLE public.chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_default_vat_rate_check
  CHECK (default_vat_rate IS NULL OR default_vat_rate IN (0, 0.06, 0.12, 0.25));

COMMENT ON COLUMN public.chart_of_accounts.default_vat_rate IS
  'Per-account default VAT rate for booking lines (0/0.06/0.12/0.25). NULL = no default. Oresavrundning (3740) ships as 0 (momsfri).';

-- Existing companies: mark oresavrundning (3740) as momsfri so it stops
-- inheriting phantom moms. Only touches rows without an explicit value.
UPDATE public.chart_of_accounts
  SET default_vat_rate = 0
  WHERE account_number = '3740' AND default_vat_rate IS NULL;

-- New / imported / on-demand 3740 rows: ship momsfri too, whatever the insert
-- path (company seed, SIE import, on-demand backfill, manual add). The chart
-- seed function does not write a VAT column and 3740 is added on demand, so a
-- BEFORE INSERT default is the one place that covers every path. Fires only
-- when the caller left the rate unset, so an explicit choice always wins.
CREATE OR REPLACE FUNCTION public.set_known_momsfri_default_vat_rate()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.default_vat_rate IS NULL AND NEW.account_number = '3740' THEN
    NEW.default_vat_rate := 0;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_chart_of_accounts_momsfri_default ON public.chart_of_accounts;
CREATE TRIGGER trg_chart_of_accounts_momsfri_default
  BEFORE INSERT ON public.chart_of_accounts
  FOR EACH ROW
  EXECUTE FUNCTION public.set_known_momsfri_default_vat_rate();

NOTIFY pgrst, 'reload schema';
