-- oauth_partner_clients: partner OAuth clients added as rows, without a code change.
-- pg-test: tests/pg/oauth-partner-clients.pg.test.ts
--
-- The MCP OAuth endpoints (/api/mcp-oauth/register, /authorize and /token)
-- accept a redirect URI when it matches a built-in pattern in
-- src/lib/auth/oauth-allowlist.ts, an active row here, or a member's own
-- registration in oauth_client_registrations. A row here is a partner
-- platform whose callbacks serve all of its customers: the consent page names
-- it as a verified client, and keys minted through it carry the client
-- 'partner:<slug>'.
--
-- A row matches a redirect URI, always https and never with a port, userinfo,
-- query or fragment, when:
--   match 'exact'   the URI is exactly https://<host><path>
--   match 'prefix'  the URI is https://<host><path without a trailing slash>
--                   followed by one or more /<segment> and an optional final
--                   slash, where each segment starts with a letter, digit,
--                   '_' or '-' and holds only those and '.'
-- host is a lower-case DNS name with at least one dot (no IP address, no
-- localhost); path is '/' or plain segments of the same shape. A prefix on
-- '/' (a whole host) is refused. One active row per (host, path).
--
-- Rows sharing a slug (a partner's production and dev hosts) are one client:
-- one connector identity per user, one name in the records. revoked_at stops
-- new sign-ins through the row; a key already minted keeps working until its
-- person disconnects it, as with a revoked registration. Rows are revoked,
-- never deleted, so a revoked partner's name still labels its old keys.
--
-- The slug may not be a built-in provider or a connection kind the code
-- already uses (claude, chatgpt, ...): a row with that slug would be shadowed
-- by the built-in pattern or misread by the settings list.
--
-- Not tenant data: no company_id. Service role only: RLS on with no policies,
-- nothing for anon or authenticated, like cron_runs.

CREATE TABLE public.oauth_partner_clients (
  id          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  slug        text NOT NULL,
  name        text NOT NULL,
  host        text NOT NULL,
  path        text NOT NULL,
  match       text NOT NULL DEFAULT 'exact',
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  CONSTRAINT oauth_partner_clients_slug_format
    CHECK (slug ~ '^[a-z][a-z0-9_]{1,39}$'),
  CONSTRAINT oauth_partner_clients_slug_not_built_in
    CHECK (slug NOT IN (
      'claude', 'chatgpt', 'grok', 'gemini', 'copilot', 'cursor', 'cursor_deeplink',
      'squidler', 'celemine', 'flytt_extension', 'local',
      'mcp', 'key', 'partner', 'registered'
    )),
  CONSTRAINT oauth_partner_clients_name_format
    CHECK (name = btrim(name) AND char_length(name) BETWEEN 1 AND 80 AND name !~ '[[:cntrl:]]'),
  CONSTRAINT oauth_partner_clients_host_format
    CHECK (char_length(host) <= 253 AND host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$'),
  CONSTRAINT oauth_partner_clients_path_format
    CHECK (char_length(path) <= 512 AND (path = '/' OR path ~ '^(/[A-Za-z0-9_-][A-Za-z0-9._-]*)+/?$')),
  CONSTRAINT oauth_partner_clients_match_check
    CHECK (match IN ('exact', 'prefix')),
  CONSTRAINT oauth_partner_clients_prefix_not_root
    CHECK (match = 'exact' OR path <> '/'),
  CONSTRAINT oauth_partner_clients_revoked_after_created
    CHECK (revoked_at IS NULL OR revoked_at >= created_at)
);

COMMENT ON TABLE public.oauth_partner_clients IS
  'Partner OAuth clients for the MCP OAuth endpoints: a verified client name per callback host and path (exact or hardened prefix). Service role only; revoke with revoked_at, never delete.';

-- The lookup reads the active rows of one host; one active row per callback.
CREATE UNIQUE INDEX uq_oauth_partner_clients_active_callback
  ON public.oauth_partner_clients (host, path)
  WHERE revoked_at IS NULL;

-- The records name a key's partner by slug, revoked rows included.
CREATE INDEX idx_oauth_partner_clients_slug
  ON public.oauth_partner_clients (slug, created_at DESC);

ALTER TABLE public.oauth_partner_clients ENABLE ROW LEVEL SECURITY;
-- service_role is revoked too before its grant, so no default privilege can
-- leave it DELETE or TRUNCATE.
REVOKE ALL ON TABLE public.oauth_partner_clients FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.oauth_partner_clients TO service_role;

NOTIFY pgrst, 'reload schema';
