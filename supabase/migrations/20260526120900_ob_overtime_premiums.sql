-- =============================================================================
-- OB-tillägg & övertid: shift-premium automation
-- =============================================================================
--
-- Adds:
--   1. New salary_line_items.item_type values for shift premiums (OB) and
--      tiered overtime (övertid 50 %/100 %).
--   2. Optional start_time / end_time columns on salary_worked_days so the
--      calculator can match per-shift windows against premium rules. Legacy
--      rows (NULL times) fall back to a default-shift assumption inside the
--      engine (08:00–17:00) — pure-night/weekend rules will not trigger for
--      hours-only days, which mirrors how those rows were intended to behave
--      before this migration.
--   3. shift_premium_rules — per-company configuration of when and how much
--      to top up the base hourly rate. Either applies to all employees or a
--      filtered list. Multiple rules may match a shift; the engine prefers
--      higher priority and tie-breaks on higher premium_percent. ISO weekday
--      encoding (1 = Monday … 7 = Sunday) matches PostgreSQL's
--      extract(isodow from date), so server-side queries can filter natively.
--
-- CHECK migration note: the new item_type CHECK preserves every existing
-- value (including gross_deduction_*, net_deduction_advance/benefit_payment,
-- semesterersattning, benefit_bike). Adding values without listing the
-- originals would drop rows on commit.

ALTER TABLE public.salary_line_items DROP CONSTRAINT IF EXISTS salary_line_items_item_type_check;

ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_item_type_check
  CHECK (item_type IN (
    'monthly_salary', 'hourly_salary',
    'overtime', 'overtime_50', 'overtime_100',
    'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday',
    'bonus', 'commission',
    'gross_deduction_pension', 'gross_deduction_other',
    'benefit_car', 'benefit_housing', 'benefit_meals', 'benefit_wellness', 'benefit_bike', 'benefit_other',
    'sick_karens', 'sick_day2_14', 'sick_day15_plus',
    'vab', 'parental_leave', 'vacation', 'semesterersattning',
    'traktamente_taxfree', 'traktamente_taxable',
    'mileage_taxfree', 'mileage_taxable',
    'net_deduction_advance', 'net_deduction_union', 'net_deduction_benefit_payment', 'net_deduction_other',
    'correction', 'other'
  ));

-- --------------------------------------------------------------------------
-- Per-shift time columns on salary_worked_days
-- --------------------------------------------------------------------------
-- Nullable so existing hours-only rows continue to work. When both times are
-- set the engine uses the explicit overlap with the rule window; when either
-- is NULL the engine falls back to a default-shift assumption.

ALTER TABLE public.salary_worked_days
  ADD COLUMN IF NOT EXISTS start_time TIME NULL,
  ADD COLUMN IF NOT EXISTS end_time TIME NULL;

-- --------------------------------------------------------------------------
-- shift_premium_rules
-- --------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.shift_premium_rules (
  id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id                  UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  applies_to_all_employees    BOOLEAN NOT NULL DEFAULT TRUE,
  applies_to_employee_ids     UUID[] NOT NULL DEFAULT '{}',
  -- ISO weekday array: 1 = Monday … 7 = Sunday. Matches extract(isodow from x).
  day_of_week                 INT[] NOT NULL,
  start_time                  TIME NOT NULL,
  end_time                    TIME NOT NULL,
  premium_percent             NUMERIC(5, 2) NOT NULL
                                CHECK (premium_percent >= 0 AND premium_percent <= 500),
  item_type                   TEXT NOT NULL,
  priority                    INT NOT NULL DEFAULT 0,
  is_active                   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by                  UUID REFERENCES auth.users(id),
  -- Only allow the dedicated premium types here. 'overtime' (untyped) is
  -- excluded because manually-flagged overtime line items do not need a rule;
  -- premium rules are exclusively for the new tiered + OB families.
  CONSTRAINT shift_premium_rules_item_type_check CHECK (item_type IN (
    'overtime_50', 'overtime_100',
    'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday'
  )),
  -- Day-of-week array must contain at least one ISO day in [1, 7].
  CONSTRAINT shift_premium_rules_day_of_week_check CHECK (
    array_length(day_of_week, 1) >= 1
    AND array_length(day_of_week, 1) <= 7
    AND day_of_week <@ ARRAY[1, 2, 3, 4, 5, 6, 7]
  )
);

CREATE INDEX IF NOT EXISTS idx_shift_premium_rules_company
  ON public.shift_premium_rules (company_id)
  WHERE is_active = TRUE;

ALTER TABLE public.shift_premium_rules ENABLE ROW LEVEL SECURITY;

CREATE POLICY "shift_premium_rules_select" ON public.shift_premium_rules
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "shift_premium_rules_insert" ON public.shift_premium_rules
  FOR INSERT WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "shift_premium_rules_update" ON public.shift_premium_rules
  FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "shift_premium_rules_delete" ON public.shift_premium_rules
  FOR DELETE USING (company_id IN (SELECT public.user_company_ids()));

CREATE TRIGGER shift_premium_rules_updated_at
  BEFORE UPDATE ON public.shift_premium_rules
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
