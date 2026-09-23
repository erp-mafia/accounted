-- One row per browser-driven OAuth flow that must finish on the origin it
-- started from and for the user who started it.
--
-- The Skatteverket consent used to live as six per-company keys in
-- extension_data (oauth_state, oauth_user_id, oauth_redirect_uri,
-- oauth_code_verifier, oauth_connector_state, oauth_return_to). Per-company
-- keys meant a second connect overwrote the first mid-flight, the callback
-- scanned every company's state row to find its own, the state was deleted
-- only after the token exchange (two deliveries could both find it), and
-- nothing recorded which origin (app or white-label brand) the flow started
-- on, so the callback always answered the canonical app origin.
--
-- This table is the single source of truth for such a flow. The row id is
-- the OAuth `state` sent to the provider: an unguessable random token that
-- encodes nothing. Consuming the state and consuming the handoff are each
-- one UPDATE / DELETE whose WHERE clause carries the whole check
-- (unconsumed, unexpired, and for the handoff the destination origin), so a
-- replayed or concurrent callback loses the row-lock race with no
-- read-then-write window.
--
-- Two-hop flow on hosted: the provider redirects to the registered callback
-- host (app.gnubok.se), which carries no app session. Hop 1 consumes the
-- state, encrypts the provider code (or error) into the handoff columns and
-- 302s to the recorded origin with the separate handoff id. Hop 2 on that
-- origin consumes the handoff (DELETE RETURNING, bound to the origin),
-- verifies the completing browser's session is the initiating user, and
-- exchanges the code. Self-hosted (callback host = app host) is one hop.
--
-- Service-role only: written by /authorize and consumed by /callback with the
-- service client. No user-facing role may read a code verifier or a held
-- provider code. Not räkenskapsinformation; classified as infrastructure in
-- lib/reports/full-archive-export.ts. Rows cascade with the company and the
-- user; expired rows are purged opportunistically by /authorize.

CREATE TABLE public.oauth_flows (
  id                 text PRIMARY KEY,
  kind               text NOT NULL,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  origin             text NOT NULL,
  redirect_uri       text NOT NULL,
  code_verifier      text,
  connector_state    text,
  return_to          text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  used_at            timestamptz,
  handoff_id         text UNIQUE,
  handoff_code       text,
  handoff_error      text,
  handoff_expires_at timestamptz,
  CONSTRAINT oauth_flows_kind_check CHECK (kind IN ('skatteverket')),
  CONSTRAINT oauth_flows_handoff_shape CHECK (
    (handoff_id IS NULL AND handoff_code IS NULL AND handoff_error IS NULL AND handoff_expires_at IS NULL)
    OR (handoff_id IS NOT NULL AND handoff_expires_at IS NOT NULL AND used_at IS NOT NULL
        AND (handoff_code IS NOT NULL OR handoff_error IS NOT NULL))
  )
);

COMMENT ON TABLE public.oauth_flows IS
  'One row per browser OAuth flow (state = id). Written by /authorize, consumed atomically by /callback. code_verifier, handoff_code and handoff_error are AES-256-GCM ciphertext (lib/auth/oauth-flow-crypto.ts). Service-role only.';
COMMENT ON COLUMN public.oauth_flows.origin IS
  'Validated app or brand origin the flow started on; the callback finishes there and the handoff may only be consumed from there.';
COMMENT ON COLUMN public.oauth_flows.handoff_id IS
  'Separate random token for hop 2; never the state, so the provider redirect URL alone cannot claim the handoff.';

CREATE INDEX idx_oauth_flows_expires_at ON public.oauth_flows (expires_at);

-- No policies on purpose: nothing but the service client touches this table.
ALTER TABLE public.oauth_flows ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.oauth_flows FROM anon, authenticated;

NOTIFY pgrst, 'reload schema';
