-- =============================================================================
-- booking_template_library.pack_slug
-- =============================================================================
--
-- System booking templates move from rows frozen inside migration
-- 20260413160000 to data files under packs/, synced by lib/packs/sync.ts.
--
-- The sync needs a stable key to upsert against. Matching on `name` would lose
-- a template's identity the moment its Swedish label is corrected, orphaning
-- its booking_template_usage rows (which reference template_id) and resetting
-- every company's "recently used" ordering. pack_slug is that key: it is the
-- pack filename, treated as an identifier and never renamed.
--
-- Scope: system templates only. Company- and team-authored templates keep
-- pack_slug NULL, which is why the unique index is partial.

ALTER TABLE public.booking_template_library
  ADD COLUMN IF NOT EXISTS pack_slug TEXT;

COMMENT ON COLUMN public.booking_template_library.pack_slug IS
  'Slug of the packs/<slug>.yaml file this system template is synced from. '
  'NULL for company- and team-authored templates. The stable upsert key for '
  'lib/packs/sync.ts: never rename one, it is the public lookup key.';

-- Lowercase kebab-case, mirroring PACK_SLUG_RE in lib/packs/schema.ts so the
-- database refuses a value the loader would reject.
ALTER TABLE public.booking_template_library
  DROP CONSTRAINT IF EXISTS btl_pack_slug_format;
ALTER TABLE public.booking_template_library
  ADD CONSTRAINT btl_pack_slug_format
  CHECK (pack_slug IS NULL OR pack_slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$');

-- A pack maps to exactly one system template. Partial so the thousands of
-- company templates (all NULL) are not forced unique against each other.
CREATE UNIQUE INDEX IF NOT EXISTS btl_pack_slug_unique
  ON public.booking_template_library (pack_slug)
  WHERE pack_slug IS NOT NULL;

-- Only a system template may carry a pack_slug: a company template claiming one
-- would collide with the pack it shadows on the next sync.
ALTER TABLE public.booking_template_library
  DROP CONSTRAINT IF EXISTS btl_pack_slug_system_only;
ALTER TABLE public.booking_template_library
  ADD CONSTRAINT btl_pack_slug_system_only
  CHECK (pack_slug IS NULL OR is_system);

-- -----------------------------------------------------------------------------
-- Backfill: adopt the 26 rows seeded by 20260413160000 rather than replacing
-- them, so existing booking_template_usage rows keep pointing at a live
-- template and nobody's "recently used" list resets.
--
-- Matched on the exact seeded name. A name that does not match any pack (none
-- today) simply stays NULL and is reported by the sync as an orphan instead of
-- being silently deleted here.
-- -----------------------------------------------------------------------------
UPDATE public.booking_template_library SET pack_slug = v.slug
FROM (VALUES
  ('Aktieägarlån — återbetalning'          , 'aktieagarlan-aterbetalning'),
  ('Aktieägarlån — insättning'             , 'aktieagarlan-insattning'),
  ('Arbetsgivaravgifter via skattekonto'   , 'arbetsgivaravgifter-via-skattekonto'),
  ('Arbetsgivaravgifter'                   , 'arbetsgivaravgifter'),
  ('Bankavgift'                            , 'bankavgift'),
  ('Beräknad bolagsskatt'                  , 'beraknad-bolagsskatt'),
  ('Eget insättning'                       , 'eget-insattning'),
  ('Eget uttag'                            , 'eget-uttag'),
  ('Försäljning EU-tjänster (B2B)'         , 'forsaljning-eu-tjanster-b2b'),
  ('Försäljning export (utanför EU)'       , 'forsaljning-export-utanfor-eu'),
  ('Inköp EU-tjänster, omvänd moms 25%'    , 'inkop-eu-tjanster-omvand-moms-25'),
  ('Inköp EU-varor, omvänd moms 25%'       , 'inkop-eu-varor-omvand-moms-25'),
  ('Insättning skattekonto'                , 'insattning-skattekonto'),
  ('Löneutbetalning'                       , 'loneutbetalning'),
  ('Momsbetalning via skattekonto'         , 'momsbetalning-via-skattekonto'),
  ('Momsredovisning (nettning)'            , 'momsredovisning-nettning'),
  ('Överavskrivning inventarier'           , 'overavskrivning-inventarier'),
  ('Periodiseringsfond återföring (AB)'    , 'periodiseringsfond-aterforing-ab'),
  ('Periodiseringsfond avsättning (AB)'    , 'periodiseringsfond-avsattning-ab'),
  ('Preliminär F-skatt (AB)'               , 'preliminar-f-skatt-ab'),
  ('Preliminär F-skatt (EF)'               , 'preliminar-f-skatt-ef'),
  ('Ränteintäkt'                           , 'ranteintakt'),
  ('Räntekostnad'                          , 'rantekostnad'),
  ('Representation (avdragsgill, 25% moms)', 'representation-avdragsgill-25-moms'),
  ('Skatteåterbäring'                      , 'skatteaterbaring'),
  ('Utdelning till aktieägare'             , 'utdelning-till-aktieagare')
) AS v(name, slug)
WHERE public.booking_template_library.is_system
  AND public.booking_template_library.name = v.name
  AND public.booking_template_library.pack_slug IS NULL;

NOTIFY pgrst, 'reload schema';
