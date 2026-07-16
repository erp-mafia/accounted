-- Currencies reference table: single source of truth for the supported
-- currency code list. Previously the list was hard-coded in many places
-- (CurrencySchema, the journal-entry/invoice editors, CHECK constraints). This
-- table lets the UI fetch the options and lets columns FK against it instead of
-- repeating a literal list. Global reference data, NOT company-scoped.
CREATE TABLE IF NOT EXISTS public.currencies (
  code        text PRIMARY KEY CHECK (code ~ '^[A-Z]{3}$'),  -- ISO 4217 alpha-3
  name        text NOT NULL,
  sort_order  integer NOT NULL DEFAULT 100,
  active      boolean NOT NULL DEFAULT true
);

-- Seed the codes the app already supported. Add rows here (no code change) to
-- offer more currencies.
INSERT INTO public.currencies (code, name, sort_order) VALUES
  ('SEK', 'Swedish krona', 10),
  ('EUR', 'Euro', 20),
  ('USD', 'US dollar', 30),
  ('GBP', 'Pound sterling', 40),
  ('NOK', 'Norwegian krone', 50),
  ('DKK', 'Danish krone', 60)
ON CONFLICT (code) DO NOTHING;

-- Reference data: every authenticated user may read it; nobody writes it from
-- the app (managed via migrations).
ALTER TABLE public.currencies ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated read currencies"
  ON public.currencies FOR SELECT
  TO authenticated
  USING (true);

NOTIFY pgrst, 'reload schema';
