-- Anläggningsregistret: how an asset came onto the books.
--
-- The note on anläggningstillgångar (ÅRL 5 kap. 8 §) shows, per balance sheet
-- post, what was bought, what came in through a rörelseförvärv or a fusion and
-- what was moved in from another post, each on its own row (the K2 taxonomy:
-- Inköp, Rörelseförvärv, Fusion, Omklassificeringar). Only the asset knows
-- which it was, so the register holds it, as it holds how an asset left
-- (disposal_type).
--
--   purchase              bought (the default, and every row so far)
--   business_acquisition  taken over in a rörelseförvärv (inkråmsförvärv)
--   merger                taken over in a fusion
--   reclassification      moved in from another balance sheet post (varulager,
--                         pågående nyanläggningar)
--
-- For a merger or a reclassification the asset's acquisition_date is the day
-- it came in, and opening_accumulated_depreciation what was taken over with
-- it. Nothing is booked from this column: it decides the row of the note.
--
-- Not a financial attribute: enforce_asset_post_disposal_immutability is left
-- as it is, so the row of the note can still be corrected on a disposed asset.
-- A new column on an existing table: its RLS policies and grants cover it.
-- pg-test: skip (a column with a default and a CHECK constraint; no trigger, RPC or RLS change)

ALTER TABLE public.assets
  ADD COLUMN acquisition_type text NOT NULL DEFAULT 'purchase'
    CONSTRAINT assets_acquisition_type_check CHECK (
      acquisition_type IN ('purchase', 'business_acquisition', 'merger', 'reclassification')
    );

COMMENT ON COLUMN public.assets.acquisition_type IS
  'How the asset came onto the books: purchase, business_acquisition (rörelseförvärv), merger (fusion) or reclassification (moved in from another balance sheet post). Decides the row of the note on anläggningstillgångar; nothing is booked from it.';

NOTIFY pgrst, 'reload schema';
