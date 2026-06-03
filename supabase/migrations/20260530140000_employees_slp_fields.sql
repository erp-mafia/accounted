-- Migration: employees SLP/SN statistics fields.
--
-- SCB Lönestrukturstatistik (AM/SLP) and Svenskt Näringsliv's wage statistics
-- share one individual-level postbeskrivning (SCB-FS 2022:6 Bilaga 1). Its
-- fixed part (position 1–70) needs per-employee coded attributes gnubok does
-- not otherwise track. The code domains live in SCB's separate "Instruktion"
-- document, so we store the raw codes the user enters rather than deriving them.
--
--   ssyk_code         Yrkeskod enligt SSYK 2012 (4 digits, pos 44–47)
--   cfar_number       Arbetsställets CFAR-nummer (8 digits, pos 56–63)
--   arbetstidsart     Arbetstidsart, Instruktionen fält 15 (1 char, pos 43)
--   anstallningsform  1 = tillsvidare, 2 = visstid (styrkod 700)
--
-- All nullable: existing rows are unclassified and the generators zero-fill +
-- surface a "needs completion" warning.

ALTER TABLE public.employees
  ADD COLUMN ssyk_code TEXT
    CHECK (ssyk_code IS NULL OR ssyk_code ~ '^\d{1,4}$'),
  ADD COLUMN cfar_number TEXT
    CHECK (cfar_number IS NULL OR cfar_number ~ '^\d{1,8}$'),
  ADD COLUMN arbetstidsart TEXT
    CHECK (arbetstidsart IS NULL OR length(arbetstidsart) <= 1),
  ADD COLUMN anstallningsform TEXT
    CHECK (anstallningsform IS NULL OR anstallningsform IN ('1', '2'));

NOTIFY pgrst, 'reload schema';
