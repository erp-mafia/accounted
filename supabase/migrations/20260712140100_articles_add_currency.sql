-- Articles: optional default currency for the article's price.
--
-- Pre-fills the invoice currency when the article is added to a line (the
-- invoice still carries a single currency; the article supplies the default).
-- 'SEK' = the existing behaviour. Master data only, never posted; the frozen
-- invoice line keeps its own currency, so editing this never moves a voucher.
--
-- Validity is enforced by a FK to public.currencies, NOT a literal CHECK list,
-- so the supported set lives in one place (the currencies table).
ALTER TABLE public.articles
  ADD COLUMN IF NOT EXISTS currency text NOT NULL DEFAULT 'SEK'
    REFERENCES public.currencies(code);

NOTIFY pgrst, 'reload schema';
