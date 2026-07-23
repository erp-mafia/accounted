-- Share-capital facts for the annual report aktiekapital note (K2/K3, ÅRL).
-- The report builder has read these since the ÅR feature shipped, but the
-- columns were never created, so the "fyll i under Inställningar → Företag"
-- warning was a dead end for every AB. Kvotvärde is intentionally NOT stored:
-- ABL 1 kap 6 § defines it as aktiekapital / antal aktier, so it is derived
-- at read time to keep a Bolagsverket-filed note internally consistent.

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS aktiekapital numeric,
  ADD COLUMN IF NOT EXISTS antal_aktier integer;

COMMENT ON COLUMN public.company_settings.aktiekapital IS
  'Registered share capital in SEK per Bolagsverket. Used for the aktiekapital note in the annual report; may differ from the booked 2081 balance during a pending emission.';
COMMENT ON COLUMN public.company_settings.antal_aktier IS
  'Total number of issued shares per Bolagsverket. Used for the aktiekapital note; kvotvärde is derived as aktiekapital / antal_aktier.';

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_aktiekapital_positive;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_aktiekapital_positive
  CHECK (aktiekapital IS NULL OR aktiekapital > 0);

ALTER TABLE public.company_settings
  DROP CONSTRAINT IF EXISTS company_settings_antal_aktier_positive;
ALTER TABLE public.company_settings
  ADD CONSTRAINT company_settings_antal_aktier_positive
  CHECK (antal_aktier IS NULL OR antal_aktier > 0);

NOTIFY pgrst, 'reload schema';
