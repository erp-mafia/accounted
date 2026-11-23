-- K2 årsredovisning: the few rows of the note on anläggningstillgångar (ÅRL 5
-- kap. 8 §) that neither the anläggningsregister nor the ledger can tell
-- apart, as the user states them for the räkenskapsår
-- (src/lib/bokslut/arsredovisning/k2-fixed-asset-note.ts).
--
-- arsredovisning_narratives.fixed_asset_note_rows: per balance sheet post
-- (the K2 concept, for example MaskinerAndraTekniskaAnlaggningar) the stated
-- rows and their amounts in whole kronor, positive as the taxonomy's standard
-- label names the row:
--   { "<post>": { "cost.omrakningsdifferenser": 15000,
--                 "impairment.fusion": 40000, ... } }
-- The rows are omräkningsdifferenser, and where a nedskrivning booked on the
-- post's write-down accounts outside the register came from or went: fusion,
-- försäljning or utrangering, omklassificering, omräkning. Everything else in
-- the note is derived from the register (each asset says how it was acquired,
-- assets.acquisition_type) and from the ledger.
-- '{}' is "nothing stated": the note is the register's alone, as before.
-- The app validates posts, rows and amounts (workflow-schemas.ts); the CHECK
-- bounds the shape and the size, as for note_overrides.
--
-- A new column on an existing table: its company-scoped RLS policies already
-- cover it; no policy, trigger or RPC changes.
-- pg-test: skip (a column with a CHECK constraint only; no trigger, RPC or RLS change)

ALTER TABLE public.arsredovisning_narratives
  ADD COLUMN fixed_asset_note_rows JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (
      jsonb_typeof(fixed_asset_note_rows) = 'object'
      AND octet_length(fixed_asset_note_rows::text) <= 64000
    );

COMMENT ON COLUMN public.arsredovisning_narratives.fixed_asset_note_rows IS
  'K2 anläggningstillgångar note: rows the register cannot know, per balance sheet post and row key, in kronor (lib/bokslut/arsredovisning/k2-fixed-asset-note.ts).';

NOTIFY pgrst, 'reload schema';
