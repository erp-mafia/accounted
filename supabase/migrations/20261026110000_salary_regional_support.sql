-- Regionalt stöd: the särskilt avdrag from arbetsgivaravgifterna for work at
-- a fast driftställe in a stödområde (lagen (2001:1170) om särskilda avdrag
-- i vissa fall vid avgiftsberäkningen, 2 § as amended from 2026-01-01).
--
-- The company attests that its employees work at a fast driftställe in a
-- stödområde and that its business is not excluded (4 §: stål, kol,
-- transport and tillhörande infrastruktur, a main activity in finans and
-- försäkring or koncernintern verksamhet). When on, a salary run calculated
-- afterwards snapshots it into salary_runs.calculation_params, its AGI
-- declares FK471 UlagRegionaltStod and FK476 AvdragRegionaltStod (10 % of
-- the underlag, at most 7 100 kr per period), and its booking credits the
-- avdrag back on 7510 so 2731 equals the FK487 Skatteverket draws
-- (lib/salary/regional-support.ts).
--
-- DEFAULT false: every existing company and run is unchanged.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS salary_regional_support boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.salary_regional_support IS
  'Regionalt stöd: employees work at a fast driftställe in a stödområde (lag 2001:1170). New salary runs declare FK471/FK476 and book the avdrag.';
