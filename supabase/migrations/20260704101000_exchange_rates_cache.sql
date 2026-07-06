-- Persistent read-through cache for Riksbanken exchange rates.
--
-- Before this, every enable-banking sync cron run re-fetched every unique
-- (currency, date) pair straight from Riksbanken — a first sync of one
-- foreign-currency account fired up to ~180 parallel requests at 05:00 and
-- got rate-limited (429). The failure path then silently booked transactions
-- with hardcoded fallback rates (EUR at exactly 11.5).
--
-- Rates are public reference data shared across all tenants — no company_id.
-- rate_date is the date the rate was requested FOR; observation_date is the
-- Riksbanken observation backing it (differs on weekends/holidays, where the
-- most recent prior observation answers the request).
CREATE TABLE IF NOT EXISTS public.exchange_rates (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  currency         TEXT NOT NULL CHECK (length(currency) = 3),
  rate_date        DATE NOT NULL,
  rate             NUMERIC NOT NULL CHECK (rate > 0),
  observation_date DATE NOT NULL,
  source           TEXT NOT NULL DEFAULT 'riksbanken',
  fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (currency, rate_date)
);

ALTER TABLE public.exchange_rates ENABLE ROW LEVEL SECURITY;

-- Readable and insertable by any authenticated user: the cache is filled
-- lazily from whichever request needs a rate first, and the data is public
-- (Riksbanken publishes it). No UPDATE/DELETE policies — a cached
-- (currency, rate_date) observation never changes; conflicting inserts use
-- ignoreDuplicates.
DROP POLICY IF EXISTS "exchange_rates_select" ON public.exchange_rates;
CREATE POLICY "exchange_rates_select" ON public.exchange_rates
  FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "exchange_rates_insert" ON public.exchange_rates;
CREATE POLICY "exchange_rates_insert" ON public.exchange_rates
  FOR INSERT TO authenticated WITH CHECK (true);

NOTIFY pgrst, 'reload schema';
