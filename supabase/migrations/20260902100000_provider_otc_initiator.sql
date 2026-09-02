-- Security audit 2026-09-01: bind the arcim-migration OAuth state to the user
-- who started the flow.
--
-- provider_otc rows are the `state` handed to Fortnox/Visma when a user starts
-- a provider connect (extensions/general/arcim-migration). The unauthenticated
-- GET /callback resolved the consent from that row and exchanged the code for
-- tokens without asking WHO completed the flow: a victim lured into approving
-- a consent someone else started had their provider account bound to the
-- initiator's consent (and the initiator's next migration imported the
-- victim's ledger). The callback now compares the completing browser's cookie
-- session to the initiator recorded here (lib/auth/oauth-flow-binding.ts).
--
-- Nullable on purpose: rows minted before this migration carry no initiator.
-- They expire within 10 minutes and the callback refuses them, so at most one
-- in-flight connect has to be restarted at deploy time.
--
-- No policy change: 20260902090000 made provider_otc service_role only (all
-- member policies dropped, privileges revoked from anon/authenticated), and
-- every reader and writer goes through createServiceClient().

ALTER TABLE public.provider_otc
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

COMMENT ON COLUMN public.provider_otc.user_id IS
  'The user who started the OAuth flow this state was minted for. GET /callback refuses a completion by any other session.';

NOTIFY pgrst, 'reload schema';
