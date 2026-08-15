-- The predecessor constraint does not recognize the corrected non-EU service
-- vocabulary. Remove it before the next migration normalizes legacy values;
-- the class-aware constraint is restored immediately afterwards.
ALTER TABLE public.chart_of_accounts
  DROP CONSTRAINT IF EXISTS chart_of_accounts_default_vat_treatment_check;
