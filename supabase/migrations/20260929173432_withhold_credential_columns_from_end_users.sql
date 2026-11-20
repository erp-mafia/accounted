-- Withhold credential columns from end-user roles (CASA AL1 test cases 6.7.1
-- "securely store access tokens, API keys, and other server-side secrets"
-- and 7.3.2 "webhook signing secrets managed securely"; issue #3191).
--
-- Every company member, read-only viewers included, could SELECT these
-- columns through PostgREST with their own session token: `authenticated`
-- held table-level SELECT and each table's SELECT policy is membership-only.
-- RLS filters rows, never columns, so no policy could have hidden them.
--
--   webhooks.secret                     outbound HMAC signing secret
--   invoice_reminders.action_token      bearer token in the reminder link
--   calendar_feeds.feed_token           bearer token in the feed URL
--   skatteverket_tokens.access_token,
--     .refresh_token                    per-user SKV OAuth tokens (ciphertext)
--   shopify_connections.client_id_encrypted,
--     .client_secret_encrypted          Shopify app credentials (ciphertext)
--   woocommerce_connections.consumer_key_encrypted,
--     .consumer_secret_encrypted        WooCommerce REST keys (ciphertext)
--   zettle_connections.refresh_token_encrypted
--                                       Zettle OAuth token (ciphertext)
--   bolagsverket_subscriptions.auth_secret
--                                       authenticates Bolagsverket's deliveries
--                                       to our webhook, shared per orgnr
--
-- Mechanism: column privileges. Table-level SELECT is revoked from anon and
-- authenticated, and authenticated gets SELECT back on every OTHER column.
-- The grant list is read from the catalog at apply time, so a column that
-- exists in only one environment keeps its current visibility instead of
-- failing the migration (production carries calendar_feeds.token_version,
-- which no migration creates). service_role keeps full access; each code
-- path that needs a secret reads it there after the route has resolved the
-- caller's company. anon never had a row through RLS and gets nothing back.
--
-- The trap and its guard: a column added to one of these tables later stays
-- invisible to authenticated until its migration grants it, and a session
-- select('*') on these tables is refused outright (Postgres checks every
-- column the star expands to). tests/pg/credential-columns.pg.test.ts pins
-- both directions: it fails when a non-credential column is not granted to
-- authenticated and when a credential column is.
--
-- Rejected: moving each secret into a service-role-only companion table
-- (the mail_connections shape). Same confidentiality, but it needs a data
-- move plus dual reads across the deploy window, and every reader of these
-- secrets already runs on the service role.
--
-- Writes: webhooks and bolagsverket_subscriptions hold plaintext signing or
-- delivery-auth secrets and no end-user session writes either table (the v1
-- API, the dispatcher and the Bolagsverket submission path run on the service
-- role), so INSERT and UPDATE are revoked from anon and authenticated too:
-- nobody can set a signing secret they would then know. The other tables keep
-- their write grants: their credential writes already happen in server
-- routes, and a direct write can only store server-encrypted ciphertext or
-- clear it, which is what the disconnect members can already run does.

DO $$
DECLARE
  spec record;
  missing text[];
  granted text;
BEGIN
  FOR spec IN
    SELECT *
    FROM (VALUES
      ('webhooks', ARRAY['secret']),
      ('invoice_reminders', ARRAY['action_token']),
      ('calendar_feeds', ARRAY['feed_token']),
      ('skatteverket_tokens', ARRAY['access_token', 'refresh_token']),
      ('shopify_connections', ARRAY['client_id_encrypted', 'client_secret_encrypted']),
      ('woocommerce_connections', ARRAY['consumer_key_encrypted', 'consumer_secret_encrypted']),
      ('zettle_connections', ARRAY['refresh_token_encrypted']),
      ('bolagsverket_subscriptions', ARRAY['auth_secret'])
    ) AS t(table_name, withheld)
  LOOP
    -- A misspelled column name would silently withhold nothing: refuse it.
    SELECT array_agg(w) INTO missing
    FROM unnest(spec.withheld) AS w
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_attribute a
      WHERE a.attrelid = format('public.%I', spec.table_name)::regclass
        AND a.attname::text = w
        AND a.attnum > 0
        AND NOT a.attisdropped
    );
    IF missing IS NOT NULL THEN
      RAISE EXCEPTION 'withheld column(s) % not found on public.%', missing, spec.table_name;
    END IF;

    SELECT string_agg(quote_ident(a.attname::text), ', ' ORDER BY a.attnum) INTO granted
    FROM pg_attribute a
    WHERE a.attrelid = format('public.%I', spec.table_name)::regclass
      AND a.attnum > 0
      AND NOT a.attisdropped
      AND a.attname::text <> ALL (spec.withheld);

    EXECUTE format('REVOKE SELECT ON public.%I FROM anon, authenticated', spec.table_name);
    EXECUTE format('GRANT SELECT (%s) ON public.%I TO authenticated', granted, spec.table_name);
  END LOOP;
END
$$;

REVOKE INSERT, UPDATE ON public.webhooks FROM anon, authenticated;
REVOKE INSERT, UPDATE ON public.bolagsverket_subscriptions FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
