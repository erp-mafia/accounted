-- Drop the tables and functions of the in-app connector proxy.
--
-- The proxy routes (/api/connect/bank, /api/connect/skv and
-- /api/connect/entitlements) are removed in the same change: an installation
-- reaches the Connect service instead, and nothing in this application reads
-- or writes these objects any more.
--
-- Read before the change (2026-11-18): one key without a subscription, last
-- seen 2026-09-12, one connection, three counters and thirteen usage events,
-- none later than 2026-09-12.
--
-- pg-test: covered-by tests/pg/drop-hosted-connector-tables.pg.test.ts

-- 0. Fail closed if the proxy was used after the read above: a key seen or
--    made in the last 30 days, a key with a subscription, or a usage event in
--    the last 30 days. Raising here rolls the whole migration back.
DO $guard$
DECLARE
  n bigint;
BEGIN
  IF to_regclass('public.connector_usage_events') IS NOT NULL THEN
    SELECT count(*) INTO n
      FROM public.connector_usage_events
     WHERE occurred_at > now() - interval '30 days';
    IF n > 0 THEN
      RAISE EXCEPTION 'drop_hosted_connector_tables: % usage event(s) in the last 30 days, refusing to drop', n;
    END IF;
  END IF;
  IF to_regclass('public.connector_keys') IS NOT NULL THEN
    SELECT count(*) INTO n
      FROM public.connector_keys
     WHERE last_seen_at > now() - interval '30 days'
        OR created_at > now() - interval '30 days'
        OR stripe_subscription_id IS NOT NULL;
    IF n > 0 THEN
      RAISE EXCEPTION 'drop_hosted_connector_tables: % key(s) in use, refusing to drop', n;
    END IF;
  END IF;
END
$guard$;

-- 1. The functions first: plpgsql bodies are not dependency-tracked, so a
--    function left behind would fail only when called.
DROP FUNCTION IF EXISTS public.validate_and_increment_connector_key(text);
DROP FUNCTION IF EXISTS public.connector_reserve_upstream(text, integer, integer);

-- 2. The tables, children before the keys they reference.
DROP TABLE IF EXISTS public.connector_usage_events;
DROP TABLE IF EXISTS public.connector_connections;
DROP TABLE IF EXISTS public.connector_upstream_counters;
DROP TABLE IF EXISTS public.connector_keys;

NOTIFY pgrst, 'reload schema';
