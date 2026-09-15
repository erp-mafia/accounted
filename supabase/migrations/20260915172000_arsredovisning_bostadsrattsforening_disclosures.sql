-- Bostadsrättsförening: the förvaltningsberättelse inputs the ledger and
-- brf_property_facts cannot supply (ÅRL 6 kap. 3 a §, BFNAR 2012:1 kapitel
-- 38 as decided by BFN 2025-06-16, mandatory for financial years beginning
-- after 2025-12-31).
--
-- arsredovisning_narratives (per fiscal period, like the ekonomisk förening
-- disclosures in 20260915150100):
--   1. loss_financing_explanation: ÅRL 6 kap. 3 a § andra stycket. When the
--      year's result is a loss the association states what the loss means
--      for its ability to finance future commitments (räntor,
--      tomträttsavgälder, underhåll) and how (avgiftshöjning, upplåtelse av
--      hyresrätter med bostadsrätt, nya lån). Required by completeness
--      (AR-BRF-LOSS-EXPLANATION) when årets resultat < 0.
--   2. planerat_underhall_override: K3 38.7. "Kostnadsfört planerat
--      underhåll" is the maintenance carried out under the underhållsplan
--      and expensed; the seeded 5170 mixes it with repairs, so the ledger
--      figure (5170-5179) is a default the board can replace.
--   3. sparande_adjustment: K3 38.7 third paragraph. Material income or
--      cost outside the normal activity (nedskrivningar, låneeftergifter)
--      is added to or deducted from justerat resultat; signed, kr.
--   4. energikostnad_vidaredebiterad: K3 38.9 second paragraph. When
--      uppvärmning, el or vatten is re-invoiced to members after individual
--      metering the re-invoiced amount is disclosed next to the nyckeltal.
--
-- brf_property_facts (one row per company, 20260915170000):
--   5. tomtratt_expires_on: K3 38.2 second paragraph, "för hur lång tid
--      tomträtten gäller" next to the existing avgäld period date.
--   6. kvm_lokaler_bostadsratt: K3 38.3 c, årsavgift per kvm upplåten med
--      bostadsrätt split between bostäder and lokaler; the share of
--      kvm_bostadsratt that is lokaler. Null with no 3021 balance renders
--      the permitted "inga lokaler upplåtna med bostadsrätt" comment.
--
-- The columns exist for every legal form but are only rendered for the
-- bostadsrättsförening. No trigger, RPC or RLS change.
-- pg-test: skip (nullable columns with CHECK constraints only; no trigger, RPC or RLS change)

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN loss_financing_explanation text
    CHECK (loss_financing_explanation IS NULL OR char_length(loss_financing_explanation) <= 4000),
  ADD COLUMN planerat_underhall_override numeric(15, 2)
    CHECK (planerat_underhall_override IS NULL OR planerat_underhall_override >= 0),
  ADD COLUMN sparande_adjustment numeric(15, 2)
    CHECK (sparande_adjustment IS NULL OR abs(sparande_adjustment) <= 1000000000000),
  ADD COLUMN energikostnad_vidaredebiterad numeric(15, 2)
    CHECK (energikostnad_vidaredebiterad IS NULL OR energikostnad_vidaredebiterad >= 0);

COMMENT ON COLUMN public.arsredovisning_narratives.loss_financing_explanation IS
  'ÅRL 6 kap. 3 a § andra stycket (bostadsrättsförening): vad förlusten innebär för föreningens möjlighet att finansiera sina framtida ekonomiska åtaganden.';
COMMENT ON COLUMN public.arsredovisning_narratives.planerat_underhall_override IS
  'K3 38.7 (bostadsrättsförening): kostnadsfört planerat underhåll enligt underhållsplanen, kr; ersätter ledgerns 5170-5179 i sparande per kvm.';
COMMENT ON COLUMN public.arsredovisning_narratives.sparande_adjustment IS
  'K3 38.7 tredje stycket (bostadsrättsförening): väsentliga poster utanför den normala verksamheten som läggs till (+) eller dras av (-) i justerat resultat, kr.';
COMMENT ON COLUMN public.arsredovisning_narratives.energikostnad_vidaredebiterad IS
  'K3 38.9 andra stycket (bostadsrättsförening): energikostnad som vidaredebiterats efter individuell mätning, kr.';

ALTER TABLE public.brf_property_facts
  ADD COLUMN tomtratt_expires_on date,
  ADD COLUMN kvm_lokaler_bostadsratt numeric(12, 2)
    CHECK (kvm_lokaler_bostadsratt IS NULL OR kvm_lokaler_bostadsratt >= 0);

COMMENT ON COLUMN public.brf_property_facts.tomtratt_expires_on IS
  'K3 38.2 (bostadsrättsförening): den dag tomträtten gäller till; avgäldsperiodens utgång ligger i tomtratt_avgald_until.';
COMMENT ON COLUMN public.brf_property_facts.kvm_lokaler_bostadsratt IS
  'K3 38.3 c (bostadsrättsförening): kvadratmeter lokaler upplåtna med bostadsrätt, en del av kvm_bostadsratt.';

NOTIFY pgrst, 'reload schema';
