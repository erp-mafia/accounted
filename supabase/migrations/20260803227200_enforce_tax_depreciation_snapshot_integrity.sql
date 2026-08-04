-- Issue #324 follow-up: make annual tax-depreciation snapshots coherent and
-- preserve their fiscal-period chain even for direct RLS-authorized writes.

ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT fiscal_periods_tax_depreciation_arithmetic_check
  CHECK (
    tax_depreciation_method IS NULL
    OR (
      -- Completeness first: SQL NULL semantics would let a partially
      -- populated snapshot slip past the arithmetic comparisons below
      -- (NULL operands make the whole expression NULL, which passes CHECK).
      tax_depreciation_opening_value IS NOT NULL
      AND tax_depreciation_base IS NOT NULL
      AND tax_depreciation_deduction IS NOT NULL
      AND tax_depreciation_closing_value IS NOT NULL
      AND tax_depreciation_calculation IS NOT NULL
      AND (
        tax_depreciation_method <> 'rakenskapsenlig'
        OR tax_depreciation_rule IS NOT NULL
      )
      AND tax_depreciation_deduction <= tax_depreciation_base
      AND tax_depreciation_closing_value
        = tax_depreciation_base - tax_depreciation_deduction
      AND (tax_depreciation_calculation ->> 'version')::integer >= 2
      AND (tax_depreciation_calculation ->> 'elected_deduction')::numeric
        = tax_depreciation_deduction
      AND (tax_depreciation_calculation ->> 'maximum_deduction')::numeric
        >= tax_depreciation_deduction
      AND (
        tax_depreciation_method <> 'rakenskapsenlig'
        OR tax_depreciation_calculation ->> 'book_conformity_confirmed' = 'true'
      )
    )
  );

CREATE OR REPLACE FUNCTION public.guard_fiscal_period_tax_depreciation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  previous_period public.fiscal_periods%ROWTYPE;
  tax_snapshot_changed boolean;
BEGIN
  tax_snapshot_changed := (
    NEW.tax_depreciation_method IS DISTINCT FROM OLD.tax_depreciation_method
    OR NEW.tax_depreciation_rule IS DISTINCT FROM OLD.tax_depreciation_rule
    OR NEW.tax_depreciation_opening_value IS DISTINCT FROM OLD.tax_depreciation_opening_value
    OR NEW.tax_depreciation_base IS DISTINCT FROM OLD.tax_depreciation_base
    OR NEW.tax_depreciation_deduction IS DISTINCT FROM OLD.tax_depreciation_deduction
    OR NEW.tax_depreciation_closing_value IS DISTINCT FROM OLD.tax_depreciation_closing_value
    OR NEW.tax_depreciation_calculation IS DISTINCT FROM OLD.tax_depreciation_calculation
  );

  IF NOT tax_snapshot_changed THEN
    RETURN NEW;
  END IF;

  IF OLD.is_closed = true OR OLD.locked_at IS NOT NULL OR OLD.closing_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'Fiscal period is locked for tax depreciation elections'
      USING ERRCODE = 'check_violation';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.fiscal_periods successor
    WHERE successor.company_id = NEW.company_id
      AND successor.period_start > NEW.period_start
      AND successor.tax_depreciation_method IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'A later fiscal period already has a tax depreciation snapshot'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.tax_depreciation_method IS NULL THEN
    RETURN NEW;
  END IF;

  IF NEW.previous_period_id IS NOT NULL THEN
    SELECT *
    INTO previous_period
    FROM public.fiscal_periods candidate
    WHERE candidate.id = NEW.previous_period_id
      AND candidate.company_id = NEW.company_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Previous fiscal period is missing or belongs to another company'
        USING ERRCODE = 'check_violation';
    END IF;

    IF previous_period.period_end + 1 <> NEW.period_start THEN
      RAISE EXCEPTION 'Previous fiscal period is not date-adjacent'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    SELECT *
    INTO previous_period
    FROM public.fiscal_periods candidate
    WHERE candidate.company_id = NEW.company_id
      AND candidate.period_end + 1 = NEW.period_start
    ORDER BY candidate.period_end DESC
    LIMIT 1;
  END IF;

  IF previous_period.id IS NOT NULL THEN
    IF previous_period.tax_depreciation_method IS NULL
      OR previous_period.tax_depreciation_closing_value IS NULL THEN
      RAISE EXCEPTION 'Previous fiscal period has no tax depreciation snapshot'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.tax_depreciation_method <> previous_period.tax_depreciation_method THEN
      RAISE EXCEPTION 'Tax depreciation method must match the previous fiscal period'
        USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.tax_depreciation_opening_value
      IS DISTINCT FROM previous_period.tax_depreciation_closing_value THEN
      RAISE EXCEPTION 'Tax depreciation opening value must equal the previous closing value'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

-- The annual snapshot chain is authoritative. Keeping a second company-level
-- method introduced an admin/member RLS mismatch and a non-atomic second write.
ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_tax_depreciation_method_check;

ALTER TABLE public.company_settings
  DROP COLUMN IF EXISTS tax_depreciation_method;

NOTIFY pgrst, 'reload schema';
