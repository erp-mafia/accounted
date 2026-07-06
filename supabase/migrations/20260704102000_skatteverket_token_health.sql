-- Connection health for Skatteverket tokens.
--
-- SKV's `per`-flow refresh tokens live 65 minutes, so any daily cron always
-- finds a dead token; and tokens consented before a scope rollout (the AGI
-- `agd` scope is the canonical case) 403 forever until the user re-consents.
-- Neither state was persisted anywhere: the crons retried and error-logged
-- the same broken connections every night, and the UI only discovered the
-- problem after a live failure.
--
-- status:
--   'active'          — believed working; crons attempt it
--   'needs_reconsent' — a cron or API call hit a terminal auth state
--                       (SESSION_EXPIRED / REFRESH_EXHAUSTED / MISSING_SCOPE /
--                       TOKEN_CORRUPTED); crons skip it, the UI shows a
--                       reconnect prompt proactively. Reset to 'active' by
--                       storeTokens() on successful re-consent.
ALTER TABLE public.skatteverket_tokens
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_reconsent')),
  ADD COLUMN IF NOT EXISTS last_error_code TEXT,
  ADD COLUMN IF NOT EXISTS last_error_at TIMESTAMPTZ;

NOTIFY pgrst, 'reload schema';
