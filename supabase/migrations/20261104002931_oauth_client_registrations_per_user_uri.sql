-- One active registration per user and redirect URI, not per URI
-- platform-wide (crm#1654).
--
-- 20260518120000 made redirect_uri unique across every account. A third-party
-- tool that uses one fixed callback URL for all its customers (squidler.io,
-- vscode.dev) then worked only for the first customer who registered it:
-- every other customer got "already registered" on save, and could not use
-- the first one's registration either, because /authorize only accepts a
-- registration made by the consenting user or a colleague (oauth-allowlist).
-- Anyone could also claim a well-known callback URL first and lock everyone
-- else out of it.
--
-- The trust boundary is unchanged: exact URI match, and a registration only
-- counts for the user who made it and the users who share a company with
-- them. Two users registering the same URI each get their own row.
DROP INDEX IF EXISTS public.oauth_client_registrations_uri_active;

CREATE UNIQUE INDEX oauth_client_registrations_user_uri_active
  ON public.oauth_client_registrations (user_id, redirect_uri)
  WHERE revoked_at IS NULL;

-- /register, /authorize and /token look a URI up across users.
CREATE INDEX oauth_client_registrations_uri_lookup
  ON public.oauth_client_registrations (redirect_uri)
  WHERE revoked_at IS NULL;

NOTIFY pgrst, 'reload schema';
