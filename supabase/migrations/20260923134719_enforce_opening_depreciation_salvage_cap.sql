-- The first opening-balance migration reached a PR preview before its
-- salvage-value cap was corrected. Applied migrations are not replayed:
-- replace the constraint in a new version so existing previews also enforce
-- the depreciable base. Do not silently change inconsistent asset amounts.
-- pg-test: covered-by tests/pg/assets.pg.test.ts

ALTER TABLE public.assets
  DROP CONSTRAINT assets_opening_depreciation_check,
  ADD CONSTRAINT assets_opening_depreciation_check CHECK (
    opening_accumulated_depreciation >= 0
    AND opening_accumulated_depreciation <= acquisition_cost - salvage_value
    AND (
      (opening_accumulated_depreciation = 0 AND opening_depreciation_date IS NULL)
      OR (opening_accumulated_depreciation > 0 AND opening_depreciation_date IS NOT NULL)
    )
    AND (opening_depreciation_date IS NULL OR opening_depreciation_date >= acquisition_date)
  );

NOTIFY pgrst, 'reload schema';
