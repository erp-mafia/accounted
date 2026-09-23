-- INK2S 4.14 a (SRU 7763): outnyttjat underskott från föregående
-- beskattningsår is a tax-only adjustment like the two manual ones already
-- stored here, but it has its own sign (it reduces the taxable result, IL
-- 40 kap. 2 §) and its own INK2S field, so it needs its own adjustment_type
-- rather than riding on non_taxable_income and landing in 4.5c. A company
-- that imported only its recent years has no other way to carry the deficit
-- into the declaration (requested via support).

ALTER TABLE public.fiscal_period_tax_adjustments
  DROP CONSTRAINT IF EXISTS fiscal_period_tax_adjustments_adjustment_type_check;
ALTER TABLE public.fiscal_period_tax_adjustments
  ADD CONSTRAINT fiscal_period_tax_adjustments_adjustment_type_check
  CHECK (adjustment_type IN ('non_deductible_expense', 'non_taxable_income', 'deficit_carryforward'));
