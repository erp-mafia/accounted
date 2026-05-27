-- Migration: K3 component depreciation (komponentavskrivning)
--
-- BFNAR 2012:1 ch.17.4 requires K3-reporting entities to apply the
-- "component approach" to substantial fixed assets (real estate is the
-- canonical case): when significant components of an asset have materially
-- different useful lives, each component must be depreciated separately
-- on its own life. K2 (BFNAR 2016:10) has no such requirement and treats
-- the asset as a single unit.
--
-- The `k3_components` JSONB column was already added by the original
-- assets migration (20260516120000_assets_and_depreciation.sql) as a
-- reserved placeholder. This migration now activates the column by
-- documenting the shape via COMMENT and signalling the engine support.
-- The structural shape stays:
--   [{ name: string, cost: number, useful_life_months: number,
--      salvage_value?: number }]
--
-- Validation rules (enforced application-side via Zod, not DB CHECK,
-- because validating sum(cost) == acquisition_cost involves cross-column
-- math that PostgreSQL CHECKs cannot express on JSONB):
--   - sum of component costs equals acquisition_cost (±1 kr tolerance)
--   - every component has cost > 0 and useful_life_months > 0
--   - salvage_value (if present) ≤ component cost
--   - array must be non-empty when set to non-null
--
-- Only meaningful for companies with accounting_framework = 'k3' (added in
-- 20260526121500_k3_framework.sql). The API layer rejects k3_components
-- writes for K2 companies with K3_REQUIRED_FOR_COMPONENTS.
--
-- No schema change is needed beyond refreshing the column comment — the
-- column itself already exists with type JSONB.

COMMENT ON COLUMN public.assets.k3_components IS
  'K3 BFNAR 2012:1 ch 17.4 components. When non-null, asset is depreciated per-component instead of by depreciation_method. Shape: [{ name: string, cost: number, useful_life_months: number, salvage_value?: number }]. Only meaningful for companies with accounting_framework=k3. Sum of component costs must equal acquisition_cost; enforced in application code (Zod) because the cross-column constraint cannot be expressed in a CHECK on JSONB.';

NOTIFY pgrst, 'reload schema';
