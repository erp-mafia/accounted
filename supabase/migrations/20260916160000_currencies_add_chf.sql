-- Add CHF (Swiss franc) to the supported currency set. Riksbanken publishes a
-- daily rate for it (series SEKCHFPMI), so the booking path can convert it to
-- SEK like the other foreign currencies. The TypeScript side reads the same
-- set from CURRENCIES in types/index.ts.
INSERT INTO public.currencies (code, name, sort_order) VALUES
  ('CHF', 'Swiss franc', 70)
ON CONFLICT (code) DO NOTHING;
