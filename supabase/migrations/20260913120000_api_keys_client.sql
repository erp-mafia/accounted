-- Migration: api_keys.client records which AI client minted an OAuth key
--
-- The onboarding books act (issue #2438) ends with three connect buttons
-- (Claude, ChatGPT, Grok) and needs to show which one actually completed
-- the OAuth sign-in. Every key the token route mints is named
-- 'MCP-klient (OAuth)', so until now the app could count connections but
-- not tell the clients apart. The provider is already derived at consent
-- from the redirect URI (lib/auth/oauth-allowlist.ts BUILT_IN_PATTERNS)
-- and was discarded; the token route now stores it here.
--
-- Nullable, no CHECK: the values come from BuiltInProvider in code, and a
-- constraint would turn a new provider into a 500 on every fresh
-- authorization. Keys minted before this migration, keys from registered
-- (non built-in) clients, and keys created in Settings stay NULL.

ALTER TABLE public.api_keys ADD COLUMN IF NOT EXISTS client text;

COMMENT ON COLUMN public.api_keys.client IS
  'Built-in OAuth client that minted the key (claude, chatgpt, grok, cursor, cursor_deeplink, local). NULL for Settings keys, registered clients and keys older than 2026-09-13.';
