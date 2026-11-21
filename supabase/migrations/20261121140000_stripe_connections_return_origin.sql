-- Record the origin a Stripe Connect authorization was started from.
--
-- Stripe redirects every authorization to the one canonical callback URL
-- registered with it, while browser sessions are per host. A user on a
-- white-label domain therefore reaches the callback signed out. The callback
-- reads this column to send the browser back to the initiating host (where
-- the session lives) for the login bounce, the success redirect and the
-- denial message. Null means "canonical", which is what every pre-existing
-- row and every direct-domain flow gets. Same as bank_connections.oauth_origin
-- and zettle_connections.return_origin.
ALTER TABLE public.stripe_connections
  ADD COLUMN IF NOT EXISTS return_origin text;

COMMENT ON COLUMN public.stripe_connections.return_origin IS
  'Allowlist-validated app origin the OAuth flow was started from; null = canonical app URL.';

NOTIFY pgrst, 'reload schema';
