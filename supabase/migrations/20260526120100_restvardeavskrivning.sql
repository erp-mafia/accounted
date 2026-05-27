-- Migration: extend depreciation_method enum to allow 'restvardesavskrivning_25'
-- and add restvarde_target column on assets.
--
-- Background: the 20260516120000_assets_and_depreciation.sql migration
-- already reserved the 'declining_balance_30' and 'declining_balance_20'
-- enum values but the API/engine only implemented planenlig linjär
-- avskrivning. Easy-win #3 adds the three remaining Swedish methods used in
-- skattemässig avskrivning:
--
--   * declining_balance_30  — räkenskapsenlig huvudregel (IL 18 kap 13§)
--                              30% degressivt på avskrivningsunderlag
--   * declining_balance_20  — räkenskapsenlig kompletteringsregel
--                              (IL 18 kap 17§), 20% linjärt på anskaffning
--                              -- typically used on byggnader/markanläggning
--                              when book = tax depreciation
--   * restvardesavskrivning_25 — fallback method (IL 18 kap 13§ st.3) when
--                              the räkenskapsenlig requirements (ordnad
--                              bokföring + book=tax) cannot be met. Capped
--                              at 25% declining; the asset never fully
--                              depreciates so a restvärde_target is required
--                              so we know when to stop charging.
--
-- restvarde_target stores the explicit floor for restvärdeavskrivning. It is
-- distinct from the existing `salvage_value` column (which is the salvage
-- subtracted from the linear depreciable base) because the restvärde method
-- caps the *remaining book value* at the target rather than reducing the
-- depreciable base.

-- Replace the existing CHECK constraint to add 'restvardesavskrivning_25'.
-- The constraint name is auto-generated; drop by re-listing the original
-- definition. We use the column-level approach (DROP/ADD CONSTRAINT) so we
-- don't rely on the catalog name.
ALTER TABLE public.assets
  DROP CONSTRAINT IF EXISTS assets_depreciation_method_check;

ALTER TABLE public.assets
  ADD CONSTRAINT assets_depreciation_method_check
  CHECK (depreciation_method IN (
    'linear',
    'declining_balance_30',
    'declining_balance_20',
    'restvardesavskrivning_25'
  ));

-- restvarde_target: the book-value floor for restvärdeavskrivning. Required
-- iff method = 'restvardesavskrivning_25'; null otherwise.
ALTER TABLE public.assets
  ADD COLUMN restvarde_target NUMERIC(15, 2) NULL CHECK (restvarde_target IS NULL OR restvarde_target >= 0);

-- Enforce the "required iff" relationship between method and restvarde_target.
-- The biconditional avoids two failure modes:
--   1. Method = restvärde but no target → engine would loop charging 25% of
--      the remaining book value with no floor (asymptotic to zero).
--   2. Target set but method != restvärde → dead column; misleading state if
--      the user switches methods later.
ALTER TABLE public.assets
  ADD CONSTRAINT assets_restvarde_target_method_match
  CHECK (
    (depreciation_method = 'restvardesavskrivning_25') = (restvarde_target IS NOT NULL)
  );

NOTIFY pgrst, 'reload schema';
