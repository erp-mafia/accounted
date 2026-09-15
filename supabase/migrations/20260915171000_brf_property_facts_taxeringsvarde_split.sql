-- brf_property_facts: the taxeringsvärde split and the värdeår the
-- fastighetsavgift needs (PR 3 tax package).
--
-- Kommunal fastighetsavgift is charged per bostadslägenhet but capped at
-- 0,3 % of the taxeringsvärde of the BOSTADSDEL (lag 2007:1398 3 §), and
-- statlig fastighetsskatt is 1,0 % of the taxeringsvärde of the LOKALDEL
-- (lag 1984:1052 3 §). A single total taxeringsvärde cannot feed either
-- cap, so the two parts are stored next to it; the total stays for the
-- IL 2 kap. 17 § hyresvärde test and the nyckeltal. Värdeår decides the
-- nybyggnad reduction (lag 2007:1398 6 §: värdeår 2012 or later gives 15
-- avgiftsfria år, earlier värdeår five free years and five at half).
--
-- Nullable columns with CHECK constraints only; no trigger, RPC or RLS
-- change. The facts row is corrected in place, like the other columns.
-- pg-test: covered-by supabase/migrations/__tests__/bostadsrattsforening-foundation.pg.test.ts

ALTER TABLE public.brf_property_facts
  ADD COLUMN taxeringsvarde_bostader NUMERIC(15, 2)
    CHECK (taxeringsvarde_bostader IS NULL OR taxeringsvarde_bostader >= 0),
  ADD COLUMN taxeringsvarde_lokaler NUMERIC(15, 2)
    CHECK (taxeringsvarde_lokaler IS NULL OR taxeringsvarde_lokaler >= 0),
  ADD COLUMN vardear INTEGER
    CHECK (vardear IS NULL OR (vardear BETWEEN 1800 AND 2200));

COMMENT ON COLUMN public.brf_property_facts.taxeringsvarde_bostader IS
  'Taxeringsvärde för bostadsbyggnad och tomtmark (bostadsdelen), kr: underlag för kommunal fastighetsavgift (lag 2007:1398 3 §).';
COMMENT ON COLUMN public.brf_property_facts.taxeringsvarde_lokaler IS
  'Taxeringsvärde för lokaler (lokaldelen), kr: underlag för statlig fastighetsskatt 1,0 % (lag 1984:1052 3 §).';
COMMENT ON COLUMN public.brf_property_facts.vardear IS
  'Byggnadens värdeår vid fastighetstaxeringen: styr nedsättningen av fastighetsavgiften för nybyggda bostäder (lag 2007:1398 6 §).';

NOTIFY pgrst, 'reload schema';
