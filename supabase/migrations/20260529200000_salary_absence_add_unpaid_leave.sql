-- =============================================================================
-- Salary absence: add 'unpaid_leave' (tjänstledighet utan lön)
-- =============================================================================
--
-- The salary engine treats unpaid_leave as a per-day gross deduction (one
-- daily rate per day) and excludes it from semestergrundande tid (SemL 17 §
-- only paid leave types accrue vacation). It complements the existing partial-
-- month employment_start/employment_end proration: that handles new hires and
-- terminations; unpaid_leave handles sabbaticals/leave mid-employment.

ALTER TABLE public.salary_absence_days
  DROP CONSTRAINT salary_absence_days_absence_type_check;

ALTER TABLE public.salary_absence_days
  ADD CONSTRAINT salary_absence_days_absence_type_check
  CHECK (absence_type IN (
    'sick',          -- sjukfrånvaro
    'vab',           -- vård av barn (tillfällig föräldrapenning)
    'parental',      -- föräldraledighet (föräldrapenning)
    'pregnancy',     -- graviditetspenning
    'care_relative', -- närståendepenning
    'study',         -- studieledig
    'unpaid_leave',  -- tjänstledighet utan lön
    'other_leave'
  ));

-- The derived absence line items (sick_karens, vab, parental_leave, …) are
-- inserted into salary_line_items by the calculator. unpaid_leave follows the
-- same pattern, so the line-item CHECK must accept it too.
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
    'correction', 'other'
  ));

NOTIFY pgrst, 'reload schema';
