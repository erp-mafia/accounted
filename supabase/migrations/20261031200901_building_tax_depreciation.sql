-- The tax depreciation plan of a building or markanläggning (IL 19 kap.
-- 4-5 a §§ and 20 kap. 4-5 §§), for INK2S punkt 4.9 and the deferred tax on
-- the difference between book and tax value (K3 kap. 29).
--
-- Why this exists: the tax deduction for a building is a percentage a year
-- of its acquisition value set by its economic life (IL 19 kap. 5 §), plus
-- the primäravdrag for a newly built hyreshus (5 a §: twelve percent over six
-- years), and for a markanläggning at most five percent (ten for täckdiken
-- and skogsvägar, IL 20 kap. 5 §). None of it follows the book plan, least
-- of all a K3 component plan, yet INK2 reported no 4.9 adjustment: the book
-- depreciation was deducted as if it were the tax deduction.
--
-- What this migration adds, on assets: the percentage a year, the day the
-- plan starts (färdigställd or förvärvad, NULL: the acquisition date), and
-- whether the primäravdrag applies. NULL rate: no tax plan stated (INK2
-- then makes no 4.9 adjustment for the asset and says so).
--
-- A declaration that is filed never moves. INK2 is computed afresh, never
-- stored, so a plan stated today would change 4.9 and the taxable result
-- of years already closed and declared. tax_plan_applies_from is therefore
-- set by the database when a plan is stated: the first day after the last
-- fiscal year that is closed, locked or behind the company lock date. The
-- plan applies only to years starting on or after it, and once a year it
-- applied to is closed or locked, the plan can no longer be changed or
-- removed (TAX_PLAN_USED_BY_CLOSED_YEAR).
--
-- Pinned in tests/pg/building-tax-plan.pg.test.ts.

-- assets is read at every year-end and on every register page: fail the
-- migration job instead of queueing them behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.assets
  ADD COLUMN tax_depreciation_rate numeric(6, 3),
  ADD COLUMN tax_depreciation_from date,
  ADD COLUMN tax_primary_allowance boolean NOT NULL DEFAULT false,
  ADD COLUMN tax_plan_applies_from date;

ALTER TABLE public.assets
  ADD CONSTRAINT assets_tax_depreciation_check CHECK (
    (tax_depreciation_rate IS NULL OR (tax_depreciation_rate > 0 AND tax_depreciation_rate <= 100))
    AND (tax_depreciation_rate IS NULL OR category IN ('building', 'land_improvement'))
    AND (category <> 'land_improvement' OR tax_depreciation_rate IS NULL OR tax_depreciation_rate <= 10)
    AND (NOT tax_primary_allowance OR category = 'building')
    AND (tax_depreciation_from IS NULL OR tax_depreciation_from >= acquisition_date)
    AND ((tax_depreciation_rate IS NULL) = (tax_plan_applies_from IS NULL))
  );

COMMENT ON COLUMN public.assets.tax_depreciation_rate IS
  'IL 19 kap. 5 § / 20 kap. 5 §: tax depreciation in percent a year of the acquisition value (building or markanläggning); NULL: no tax plan stated.';
COMMENT ON COLUMN public.assets.tax_depreciation_from IS
  'The day the tax plan starts (the building färdigställd or förvärvad); NULL: the acquisition date.';
COMMENT ON COLUMN public.assets.tax_plan_applies_from IS
  'Set by the database when a tax plan is stated: the first day after the last fiscal year that was closed, locked or behind the lock date. The plan applies only to fiscal years starting on or after it, so a declared year never moves.';
COMMENT ON COLUMN public.assets.tax_primary_allowance IS
  'IL 19 kap. 5 a §: primäravdrag on a newly built, extended or rebuilt hyreshus, two percentage points a year for six years.';

-- =============================================================================
-- tax_plan_applies_from: set by the database, never by a caller
-- =============================================================================

CREATE FUNCTION public.set_asset_tax_plan_applies_from()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  v_lock date;
  v_from date;
BEGIN
  -- Not a change of the plan: the date stays what it was (a caller cannot
  -- move it on its own).
  IF TG_OP = 'UPDATE' THEN
    IF OLD.tax_depreciation_rate IS NOT DISTINCT FROM NEW.tax_depreciation_rate
       AND OLD.tax_depreciation_from IS NOT DISTINCT FROM NEW.tax_depreciation_from
       AND OLD.tax_primary_allowance IS NOT DISTINCT FROM NEW.tax_primary_allowance THEN
      NEW.tax_plan_applies_from := OLD.tax_plan_applies_from;
      RETURN NEW;
    END IF;
  END IF;

  SELECT cs.bookkeeping_locked_through INTO v_lock
    FROM public.company_settings cs
   WHERE cs.company_id = NEW.company_id;

  -- The day after the last fiscal year whose declaration may not move.
  SELECT max(fp.period_end) + 1 INTO v_from
    FROM public.fiscal_periods fp
   WHERE fp.company_id = NEW.company_id
     AND (fp.is_closed
          OR fp.locked_at IS NOT NULL
          OR fp.closing_entry_id IS NOT NULL
          OR (v_lock IS NOT NULL AND fp.period_end <= v_lock));

  IF TG_OP = 'UPDATE' THEN
    IF OLD.tax_plan_applies_from IS NOT NULL AND v_from IS NOT NULL AND OLD.tax_plan_applies_from < v_from THEN
      RAISE EXCEPTION 'TAX_PLAN_USED_BY_CLOSED_YEAR' USING ERRCODE = 'PT409',
        HINT = 'The tax plan was applied to a fiscal year that is now closed or locked; that year''s INK2 may not move.';
    END IF;
  END IF;

  IF NEW.tax_depreciation_rate IS NULL THEN
    NEW.tax_plan_applies_from := NULL;
  ELSE
    -- No year closed yet: every year of the company, the one the asset was
    -- acquired in included.
    NEW.tax_plan_applies_from := coalesce(
      v_from,
      LEAST(
        (SELECT min(fp.period_start) FROM public.fiscal_periods fp WHERE fp.company_id = NEW.company_id),
        NEW.acquisition_date
      )
    );
  END IF;
  RETURN NEW;
END;
$function$;

REVOKE ALL ON FUNCTION public.set_asset_tax_plan_applies_from() FROM PUBLIC, anon, authenticated;

CREATE TRIGGER set_asset_tax_plan_applies_from
  BEFORE INSERT OR UPDATE OF tax_depreciation_rate, tax_depreciation_from, tax_primary_allowance, tax_plan_applies_from
  ON public.assets
  FOR EACH ROW EXECUTE FUNCTION public.set_asset_tax_plan_applies_from();

NOTIFY pgrst, 'reload schema';
