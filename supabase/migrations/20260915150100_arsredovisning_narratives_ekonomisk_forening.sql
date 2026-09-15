-- arsredovisning_narratives: the four förvaltningsberättelse disclosures an
-- ekonomisk förening must make (ÅRL 6 kap. 3 §):
--   1. väsentliga förändringar i medlemsantalet (free text),
--   2. summan av insatsbelopp som ska återbetalas under nästa räkenskapsår
--      (EFL 10 kap. 11 och 16 §§),
--   3. den rätt till utdelning som gjorda förlagsinsatser medför,
--   4. summan av förlagsinsatser som har sagts upp och ska lösas in under de
--      nästkommande två räkenskapsåren (EFL 11 kap. 7 §).
--
-- Per fiscal period like the other disclosure overrides on this table. NULL
-- amounts render the statutory "inga" statement; the member text is required
-- before the document is fileable (lib/bokslut/arsredovisning/completeness.ts).
-- The columns exist for every legal form but are only rendered for the
-- ekonomisk förening. No trigger, RPC or RLS change.
-- pg-test: skip (nullable columns with CHECK constraints only; no trigger, RPC or RLS change)

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN member_count_change text
    CHECK (member_count_change IS NULL OR char_length(member_count_change) <= 2000),
  ADD COLUMN insatser_repayable_next_year numeric(15, 2)
    CHECK (insatser_repayable_next_year IS NULL OR insatser_repayable_next_year >= 0),
  ADD COLUMN forlagsinsatser_dividend_right text
    CHECK (forlagsinsatser_dividend_right IS NULL OR char_length(forlagsinsatser_dividend_right) <= 2000),
  ADD COLUMN forlagsinsatser_redeemable_two_years numeric(15, 2)
    CHECK (forlagsinsatser_redeemable_two_years IS NULL OR forlagsinsatser_redeemable_two_years >= 0);

COMMENT ON COLUMN public.arsredovisning_narratives.member_count_change IS
  'ÅRL 6 kap. 3 § p. 1 (ekonomisk förening): väsentliga förändringar i medlemsantalet.';
COMMENT ON COLUMN public.arsredovisning_narratives.insatser_repayable_next_year IS
  'ÅRL 6 kap. 3 § p. 2 (ekonomisk förening): insatser att återbetala under nästa räkenskapsår, kr.';
COMMENT ON COLUMN public.arsredovisning_narratives.forlagsinsatser_dividend_right IS
  'ÅRL 6 kap. 3 § p. 3 (ekonomisk förening): rätt till utdelning som förlagsinsatser medför.';
COMMENT ON COLUMN public.arsredovisning_narratives.forlagsinsatser_redeemable_two_years IS
  'ÅRL 6 kap. 3 § p. 4 (ekonomisk förening): uppsagda förlagsinsatser att lösa in inom två år, kr.';

NOTIFY pgrst, 'reload schema';
