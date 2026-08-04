-- Issue #324: separate ordinary asset depreciation from the pooled tax
-- depreciation election under IL 18 kap.

ALTER TABLE public.company_settings
  ADD COLUMN tax_depreciation_method TEXT NULL;

ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_tax_depreciation_method_check
  CHECK (tax_depreciation_method IS NULL OR tax_depreciation_method IN (
    'rakenskapsenlig',
    'restvarde'
  ));

ALTER TABLE public.fiscal_periods
  ADD COLUMN tax_depreciation_method TEXT NULL,
  ADD COLUMN tax_depreciation_rule TEXT NULL,
  ADD COLUMN tax_depreciation_opening_value NUMERIC(15, 2) NULL,
  ADD COLUMN tax_depreciation_base NUMERIC(15, 2) NULL,
  ADD COLUMN tax_depreciation_deduction NUMERIC(15, 2) NULL,
  ADD COLUMN tax_depreciation_closing_value NUMERIC(15, 2) NULL,
  ADD COLUMN tax_depreciation_calculation JSONB NULL;

ALTER TABLE public.fiscal_periods
  ADD CONSTRAINT fiscal_periods_tax_depreciation_snapshot_check
  CHECK (
    (
      tax_depreciation_method IS NULL
      AND tax_depreciation_rule IS NULL
      AND tax_depreciation_opening_value IS NULL
      AND tax_depreciation_base IS NULL
      AND tax_depreciation_deduction IS NULL
      AND tax_depreciation_closing_value IS NULL
      AND tax_depreciation_calculation IS NULL
    )
    OR
    (
      tax_depreciation_method IN ('rakenskapsenlig', 'restvarde')
      AND tax_depreciation_opening_value >= 0
      AND tax_depreciation_base >= 0
      AND tax_depreciation_deduction >= 0
      AND tax_depreciation_closing_value >= 0
      AND jsonb_typeof(tax_depreciation_calculation) = 'object'
      AND (
        (
          tax_depreciation_method = 'rakenskapsenlig'
          AND tax_depreciation_rule IN ('huvudregel_30', 'kompletteringsregel_20')
        )
        OR
        (
          tax_depreciation_method = 'restvarde'
          AND tax_depreciation_rule IS NULL
        )
      )
    )
  );

CREATE OR REPLACE FUNCTION public.guard_fiscal_period_tax_depreciation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.tax_depreciation_method IS DISTINCT FROM OLD.tax_depreciation_method
    OR NEW.tax_depreciation_rule IS DISTINCT FROM OLD.tax_depreciation_rule
    OR NEW.tax_depreciation_opening_value IS DISTINCT FROM OLD.tax_depreciation_opening_value
    OR NEW.tax_depreciation_base IS DISTINCT FROM OLD.tax_depreciation_base
    OR NEW.tax_depreciation_deduction IS DISTINCT FROM OLD.tax_depreciation_deduction
    OR NEW.tax_depreciation_closing_value IS DISTINCT FROM OLD.tax_depreciation_closing_value
    OR NEW.tax_depreciation_calculation IS DISTINCT FROM OLD.tax_depreciation_calculation
  ) AND (
    OLD.is_closed = true
    OR OLD.locked_at IS NOT NULL
    OR OLD.closing_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Fiscal period is locked for tax depreciation elections'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_fiscal_period_tax_depreciation
  BEFORE UPDATE OF
    tax_depreciation_method,
    tax_depreciation_rule,
    tax_depreciation_opening_value,
    tax_depreciation_base,
    tax_depreciation_deduction,
    tax_depreciation_closing_value,
    tax_depreciation_calculation
  ON public.fiscal_periods
  FOR EACH ROW EXECUTE FUNCTION public.guard_fiscal_period_tax_depreciation();

-- Stop the rollout if an active legacy tax-labelled asset has already driven
-- a posted ordinary-depreciation voucher. That state needs an explicit storno
-- and accountant review, not an automatic data rewrite.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.assets a
    JOIN public.depreciation_schedules ds ON ds.asset_id = a.id
    WHERE a.disposed_at IS NULL
      AND a.depreciation_method <> 'linear'
      AND ds.journal_entry_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'Cannot normalize active tax-labelled assets with posted depreciation schedules';
  END IF;
END;
$$;

-- Active rows without postings can safely return to ordinary linear book
-- depreciation. Disposed rows retain their historical method values because
-- their financial attributes are immutable.
UPDATE public.assets
SET depreciation_method = 'linear',
    restvarde_target = NULL
WHERE disposed_at IS NULL
  AND depreciation_method <> 'linear';

ALTER TABLE public.assets
  DROP CONSTRAINT IF EXISTS assets_restvarde_target_method_match;

CREATE OR REPLACE FUNCTION public.enforce_ordinary_asset_depreciation_method()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.depreciation_method <> 'linear' THEN
      RAISE EXCEPTION 'Asset depreciation_method must be linear; tax depreciation is elected per fiscal period'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.restvarde_target IS NOT NULL THEN
      RAISE EXCEPTION 'Asset restvarde_target is deprecated; tax rest value is calculated per fiscal period'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    -- Judge the post-write state: NEW.disposed_at also catches an UPDATE that
    -- reverses a disposal on a grandfathered non-linear row, which would
    -- otherwise reactivate it with a tax-method label.
    IF NEW.depreciation_method <> 'linear' AND (
      OLD.depreciation_method IS DISTINCT FROM NEW.depreciation_method
      OR NEW.disposed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Asset depreciation_method must be linear; tax depreciation is elected per fiscal period'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.restvarde_target IS NOT NULL AND (
      OLD.restvarde_target IS DISTINCT FROM NEW.restvarde_target
      OR NEW.disposed_at IS NULL
    ) THEN
      RAISE EXCEPTION 'Asset restvarde_target is deprecated; tax rest value is calculated per fiscal period'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_ordinary_asset_depreciation_method
  BEFORE INSERT OR UPDATE ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.enforce_ordinary_asset_depreciation_method();

COMMENT ON COLUMN public.company_settings.tax_depreciation_method IS
  'Company-level IL 18 tax depreciation method. NULL until explicitly selected.';
COMMENT ON COLUMN public.fiscal_periods.tax_depreciation_calculation IS
  'Versioned annual IL 18 calculation details supporting the saved tax depreciation election.';
COMMENT ON COLUMN public.assets.restvarde_target IS
  'Deprecated legacy per-asset field. New tax depreciation is pooled per fiscal period.';

NOTIFY pgrst, 'reload schema';
