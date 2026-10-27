-- OB and overtime premium rules: three amount forms, validity dates, and the
-- provenance of every payslip line a rule produces.
-- pg-test: tests/pg/shift-premium-rule-forms.pg.test.ts
--
-- 1. Amount forms (shift_premium_rules.amount_form). Kollektivavtal price a
--    premium hour three ways, and the engine (lib/salary/shift-premium-engine.ts)
--    now knows all three:
--      percent_of_hourly  premium_percent of the hourly wage (the only form
--                         until now; every existing row keeps it). Optional
--                         hourly_divisor: the agreement's own månadslön to
--                         timlön divisor for monthly-paid staff (Handels 1/166,
--                         Byggavtalet 52 x veckoarbetstid / 12), instead of the
--                         employee's schedule divisor.
--      monthly_divisor    månadslön / monthly_divisor per hour (Almega
--                         Tjänsteföretag 480/300/150, Teknikavtalet 600/400/
--                         300/150, övertid 94/72). Monthly-paid staff only.
--      sek_per_hour       a fixed amount per hour (Gröna riksavtalet).
--    The CHECK holds exactly the field of the chosen form, so a row can never
--    carry a percent and a divisor at once and the engine never has to guess.
--
-- 2. Validity (valid_from, valid_to, both inclusive). A rate step agreed for
--    2026-04-01 is a second rule valid from that day; the engine applies the
--    rule valid on the date each worked minute falls on. valid_from stays
--    nullable: an existing row has no start (it applied to every date until
--    now and keeps doing so), and the API requires it for every new rule.
--
-- 3. Provenance on salary_line_items. source_premium_rule_id links each
--    derived OB or overtime line to the rule that won its minutes, and
--    premium_basis freezes the rule as it was used (form, rate, the salary
--    or hourly wage it was applied to, validity, hours), the line-level
--    counterpart of salary_runs.calculation_params: a payslip line can be
--    explained after the rule changed, and a correction run recomputes from
--    the rules valid on the worked dates. The foreign key is NO ACTION, like
--    source_benefit_id (20260920190100) and source_recurring_line_id
--    (20260902140000): a rule a line derives from cannot be deleted, so
--    lib/salary/shift-premium-rules.ts switches it off instead.
--
-- Additive for every existing row: amount_form defaults to percent_of_hourly
-- where premium_percent is already set, both validity dates are NULL (no
-- bound), and every existing line has neither provenance column. Both tables
-- are small (shift_premium_rules has no production rows; salary_line_items a
-- few thousand), so the CHECKs are added validated in one step.

ALTER TABLE public.shift_premium_rules
  ADD COLUMN IF NOT EXISTS amount_form text NOT NULL DEFAULT 'percent_of_hourly',
  ADD COLUMN IF NOT EXISTS monthly_divisor numeric(7, 2),
  ADD COLUMN IF NOT EXISTS sek_per_hour numeric(10, 2),
  ADD COLUMN IF NOT EXISTS hourly_divisor numeric(7, 2),
  ADD COLUMN IF NOT EXISTS valid_from date,
  ADD COLUMN IF NOT EXISTS valid_to date;

ALTER TABLE public.shift_premium_rules
  ALTER COLUMN premium_percent DROP NOT NULL;

ALTER TABLE public.shift_premium_rules
  DROP CONSTRAINT IF EXISTS shift_premium_rules_amount_form_check,
  DROP CONSTRAINT IF EXISTS shift_premium_rules_amount_fields_check,
  DROP CONSTRAINT IF EXISTS shift_premium_rules_amount_bounds_check,
  DROP CONSTRAINT IF EXISTS shift_premium_rules_validity_check;

ALTER TABLE public.shift_premium_rules
  ADD CONSTRAINT shift_premium_rules_amount_form_check
    CHECK (amount_form IN ('percent_of_hourly', 'monthly_divisor', 'sek_per_hour')),
  -- Exactly the fields of the chosen form. hourly_divisor belongs to
  -- percent_of_hourly only, where it stays optional.
  ADD CONSTRAINT shift_premium_rules_amount_fields_check CHECK (
    (amount_form = 'percent_of_hourly'
       AND premium_percent IS NOT NULL
       AND monthly_divisor IS NULL
       AND sek_per_hour IS NULL)
    OR (amount_form = 'monthly_divisor'
       AND monthly_divisor IS NOT NULL
       AND premium_percent IS NULL
       AND sek_per_hour IS NULL
       AND hourly_divisor IS NULL)
    OR (amount_form = 'sek_per_hour'
       AND sek_per_hour IS NOT NULL
       AND premium_percent IS NULL
       AND monthly_divisor IS NULL
       AND hourly_divisor IS NULL)
  ),
  -- premium_percent keeps its own 0-500 CHECK from 20260526120900.
  ADD CONSTRAINT shift_premium_rules_amount_bounds_check CHECK (
    (monthly_divisor IS NULL OR (monthly_divisor >= 1 AND monthly_divisor <= 10000))
    AND (hourly_divisor IS NULL OR (hourly_divisor >= 1 AND hourly_divisor <= 1000))
    AND (sek_per_hour IS NULL OR (sek_per_hour >= 0 AND sek_per_hour <= 10000))
  ),
  ADD CONSTRAINT shift_premium_rules_validity_check
    CHECK (valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);

COMMENT ON COLUMN public.shift_premium_rules.amount_form IS
  'How a premium hour is priced: percent_of_hourly (premium_percent of the hourly wage, optionally with the agreement''s hourly_divisor for monthly-paid staff), monthly_divisor (månadslön / monthly_divisor, monthly-paid only) or sek_per_hour (fixed kronor). Exactly the field of the form is set.';
COMMENT ON COLUMN public.shift_premium_rules.hourly_divisor IS
  'percent_of_hourly only, optional: the agreement''s divisor from full-time månadslön to timlön (Handels 166). NULL = the employee''s schedule divisor (lib/salary/work-schedule.ts hourlyDivisor).';
COMMENT ON COLUMN public.shift_premium_rules.valid_from IS
  'First date the rule applies to (inclusive), judged per worked minute. Required for new rules by the API; NULL on rules created before validity existed = no start bound.';
COMMENT ON COLUMN public.shift_premium_rules.valid_to IS
  'Last date the rule applies to (inclusive). NULL = open-ended.';

ALTER TABLE public.salary_line_items
  ADD COLUMN IF NOT EXISTS source_premium_rule_id uuid REFERENCES public.shift_premium_rules(id),
  ADD COLUMN IF NOT EXISTS premium_basis jsonb;

ALTER TABLE public.salary_line_items
  DROP CONSTRAINT IF EXISTS salary_line_items_premium_source_check;

-- Both provenance columns travel together, and only on the six item types
-- the shift-premium engine derives (lib/salary/calculated-line-items.ts).
ALTER TABLE public.salary_line_items
  ADD CONSTRAINT salary_line_items_premium_source_check CHECK (
    (source_premium_rule_id IS NULL AND premium_basis IS NULL)
    OR (source_premium_rule_id IS NOT NULL
        AND premium_basis IS NOT NULL
        AND item_type IN ('overtime_50', 'overtime_100',
                          'ob_weekday_evening', 'ob_weekend', 'ob_night', 'ob_holiday'))
  );

-- The NO ACTION key is checked on every rule delete; without an index that
-- check scans salary_line_items.
CREATE INDEX IF NOT EXISTS idx_salary_line_items_source_premium_rule
  ON public.salary_line_items (source_premium_rule_id)
  WHERE source_premium_rule_id IS NOT NULL;

COMMENT ON COLUMN public.salary_line_items.source_premium_rule_id IS
  'The shift_premium_rules row whose minutes this derived OB or overtime line pays. NO ACTION: a referenced rule is switched off, never deleted.';
COMMENT ON COLUMN public.salary_line_items.premium_basis IS
  'The premium rule as the calculation used it (lib/salary/shift-premium-engine.ts PremiumBasis): form, rate, the hourly wage or månadslön it was applied to, rate per hour, validity, priority, work date and hours. Frozen with the line.';

NOTIFY pgrst, 'reload schema';
