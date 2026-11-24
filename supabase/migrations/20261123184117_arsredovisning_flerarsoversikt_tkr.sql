-- Årsredovisning: the flerårsöversikt in thousands of kronor, per
-- räkenskapsår.
--
-- arsredovisning_narratives.flerarsoversikt_tkr: when true, the
-- flerårsöversikt of the förvaltningsberättelse states nettoomsättning and
-- resultat efter finansiella poster in thousands of kronor (tkr): the PDF
-- prints them in tkr and the iXBRL document tags them at scale 3 with
-- decimals -3 (Bolagsverket's tillämpningsanvisning 2.10.3). Soliditet is a
-- percentage either way, and the statements and the notes stay in whole
-- kronor. Default false: whole kronor, as every year so far.
--
-- A tkr figure is the whole-krona figure rounded a half away from zero
-- (src/lib/bokslut/ixbrl/thousand-kronor.ts), so it never lies more than
-- 500 kr from the kronor fact the resultaträkning tags for the same post
-- (tillämpningsanvisning 2.7.3: the same concept at another scale must
-- correspond).
--
-- A new column on an existing table: its company-scoped RLS policies already
-- cover it; no policy, trigger or RPC changes.
-- pg-test: skip (a column with a default only; no trigger, RPC or RLS change)

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN flerarsoversikt_tkr BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.arsredovisning_narratives.flerarsoversikt_tkr IS
  'State the flerårsöversikt in thousands of kronor (tkr) in the PDF and the iXBRL document; the statements stay in whole kronor.';

NOTIFY pgrst, 'reload schema';
