-- arsredovisning_narratives: editable K3 note texts and the choice to leave
-- the K3 kassaflödesanalys out (erp-mafia/accounted#1361).
--
-- note_overrides: user-written note bodies keyed by a stable note key
-- (src/lib/bokslut/arsredovisning/note-overrides.ts). An absent key keeps
-- the generated text, so '{}' is "everything generated". Only text notes
-- are editable; the API refuses unknown keys, the CHECK only bounds shape
-- and size.
--
-- omit_kassaflodesanalys / kassaflodesanalys_omission_confirmed: the
-- user's choice and their confirmation that the company is not a större
-- företag (ÅRL 1 kap. 3 §). The document honours the choice only when the
-- law permits it (ÅRL 2 kap. 1 §: a större företag always includes a
-- kassaflödesanalys); that decision is made at build time from the size
-- classification, not stored here.
--
-- New columns on an existing table: the table's company-scoped RLS
-- policies (20260517140000) already cover them; no policy changes.

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN note_overrides JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (
      jsonb_typeof(note_overrides) = 'object'
      AND octet_length(note_overrides::text) <= 64000
    ),
  ADD COLUMN omit_kassaflodesanalys BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN kassaflodesanalys_omission_confirmed BOOLEAN NOT NULL DEFAULT false;

COMMENT ON COLUMN public.arsredovisning_narratives.note_overrides IS
  'User-written K3 note bodies keyed by note key. Absent key = generated text.';
COMMENT ON COLUMN public.arsredovisning_narratives.omit_kassaflodesanalys IS
  'K3: leave the kassaflödesanalys out. Honoured only for a company that is not a större företag (ÅRL 2:1, 1:3).';
COMMENT ON COLUMN public.arsredovisning_narratives.kassaflodesanalys_omission_confirmed IS
  'User confirmed the company is not a större företag (ÅRL 1:3) when the product cannot determine it.';

NOTIFY pgrst, 'reload schema';
