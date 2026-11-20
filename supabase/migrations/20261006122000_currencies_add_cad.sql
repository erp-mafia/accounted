-- Add CAD (Canadian dollar) to the supported currency set. Riksbanken publishes
-- a daily rate for it (series SEKCADPMI), so a CAD bank row can get its SEK
-- value at ingest and through refresh-exchange-rate like the other foreign
-- currencies. The TypeScript side reads the same set from CURRENCIES in
-- src/types/index.ts.
INSERT INTO public.currencies (code, name, sort_order) VALUES
  ('CAD', 'Canadian dollar', 80)
ON CONFLICT (code) DO NOTHING;
