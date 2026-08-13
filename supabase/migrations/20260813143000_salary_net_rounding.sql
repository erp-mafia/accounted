-- =============================================================================
-- Öresavrundning av nettolön (round net salary payout up to whole kronor)
-- =============================================================================
--
-- Some banks reject salary payment files whose amounts carry öre. When
-- company_settings.salary_net_rounding is on, the salary engine rounds each
-- employee's net payout UP to the nearest whole krona (never down: rounding
-- down would underpay wages) and emits a derived 'oresavrundning' line item
-- carrying the 0-99 öre difference. The line books as a debit on 3740
-- Öres- och kronutjämning; gross salary, skatteavdrag and arbetsgivaravgifter
-- are untouched, so AGI/KU are unaffected. Off by default: existing companies
-- keep exact-öre payouts.
--
-- pg-test: skip (column addition + CHECK list extension, no trigger/RPC/RLS).
-- The re-added CHECK is NOT VALID here and validated in 20260813143001 so the
-- existing-row scan runs under SHARE UPDATE EXCLUSIVE instead of the ADD's
-- ACCESS EXCLUSIVE lock (house pattern per DECISIONS.md 2026-07-13; VALIDATE
-- in the same transaction as ADD would be a no-op since the stronger lock is
-- held until commit). The new list is a strict superset of the previous one,
-- so validation cannot fail.

ALTER TABLE public.company_settings
  ADD COLUMN salary_net_rounding boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.salary_net_rounding IS
  'Öresavrundning: round each employee''s net salary payout up to whole kronor. The 0-99 öre difference books on 3740 via a derived oresavrundning line item. Off by default.';

-- The derived rounding line follows the semesterersattning pattern (the
-- calculator inserts and re-derives it on every calculate), so the line-item
-- CHECK must accept it.
ALTER TABLE public.salary_line_items
  DROP CONSTRAINT salary_line_items_item_type_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_item_type_check
  CHECK (item_type IN (
    'monthly_salary', 'hourly_salary',
    'overtime', 'overtime_50', 'overtime_100',
    'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday',
    'bonus', 'commission',
    'gross_deduction_pension', 'gross_deduction_other',
    'benefit_car', 'benefit_housing', 'benefit_meals',
    'benefit_wellness', 'benefit_bike', 'benefit_other',
    'sick_karens', 'sick_day2_14', 'sick_day15_plus',
    'vab', 'parental_leave', 'unpaid_leave',
    'vacation', 'semesterersattning',
    'traktamente_taxfree', 'traktamente_taxable',
    'mileage_taxfree', 'mileage_taxable',
    'net_deduction_advance', 'net_deduction_union',
    'net_deduction_benefit_payment', 'net_deduction_other',
    'oresavrundning',
    'correction', 'other'
  )) NOT VALID;

NOTIFY pgrst, 'reload schema';
