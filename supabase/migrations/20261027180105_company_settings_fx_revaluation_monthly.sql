-- #523 (deferred until a K3 customer asked): monthly currency revaluation as
-- an option. When true, open foreign-currency receivables and payables can be
-- revalued at a month end inside the financial year (3960/7960 against
-- 1510/2440, as at balansdagen) and the verifikat is reversed on the first day
-- of the next month (lib/bookkeeping/currency-revaluation-monthly.ts). The
-- balansdag revaluation of the year-end close is unchanged. Default false
-- keeps every existing company on the yearly revaluation only.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS fx_revaluation_monthly boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.fx_revaluation_monthly IS
  'When true: open foreign-currency items may be revalued at each month end inside the financial year, reversed the next day (#523). The balansdag revaluation is unaffected.';

NOTIFY pgrst, 'reload schema';
