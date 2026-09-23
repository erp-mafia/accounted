-- Record the origin a bank authorization was started from.
--
-- Enable Banking redirects every consent to the one canonical callback URL
-- registered with it, while browser sessions are per host. A user on a
-- white-label domain therefore reaches the callback signed out. The callback
-- reads this column to send the browser back to the initiating host (where
-- the session lives) for the login bounce, the success redirect and the
-- denial banner. Null means "canonical", which is what every pre-existing row
-- and every direct-domain flow gets.
ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS oauth_origin text;

COMMENT ON COLUMN public.bank_connections.oauth_origin IS
  'Allowlist-validated app origin the OAuth flow was started from; null = canonical app URL.';

NOTIFY pgrst, 'reload schema';
