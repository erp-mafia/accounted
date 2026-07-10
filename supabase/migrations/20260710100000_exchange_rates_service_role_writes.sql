-- Lock down writes to the shared exchange-rate cache.
-- pg-test: covered-by tests/pg/db-advisor-lockdowns.pg.test.ts
--
-- Supabase advisor (rls_policy_always_true): exchange_rates_insert allowed
-- any authenticated user to INSERT arbitrary rows (WITH CHECK (true)) into a
-- cache that feeds money math (amount_sek on ingested transactions, invoice
-- SEK conversion). Because the table is shared across all tenants and reads
-- take the first row for a (currency, rate_date) pair (UNIQUE constraint +
-- ignoreDuplicates on the writer), one malicious or buggy client could
-- poison a rate for every company.
--
-- New design: only the service role writes the cache. The 05:00
-- enable-banking sync cron (service role, the primary cache filler) bypasses
-- RLS and keeps working. User-client paths (bank file import execute,
-- refresh-exchange-rate, manual bank sync) still attempt the write; it is
-- now rejected and deliberately ignored: lib/currency/riksbanken.ts
-- writeCachedRate() is fail-soft and never inspects the upsert result, so
-- the fetched rate is returned to the caller exactly as before. Reads
-- (exchange_rates_select) are unchanged: the data is public reference data.
DROP POLICY IF EXISTS "exchange_rates_insert" ON public.exchange_rates;

-- Defense in depth: revoke the table privilege as well, so a future
-- always-true policy cannot silently reopen the hole. With RLS enabled and
-- no INSERT policy this is already denied; the REVOKE makes the intent
-- explicit and the rejection deterministic (permission denied).
REVOKE INSERT ON public.exchange_rates FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
