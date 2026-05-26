-- OAuth dynamic client registration allowlist.
--
-- The /api/mcp-oauth/{register,authorize} endpoints used to hardcode a
-- regex allowlist of redirect URIs (claude.ai/api/*, claude.com/api/*,
-- localhost). That blocked self-hosted custom apps from completing OAuth
-- against gnubok, even though the rest of the flow (PKCE, refresh
-- rotation, AES-256-GCM auth codes) is provider-agnostic.
--
-- This table lets users register their own redirect URIs through the
-- settings UI. The hardcoded patterns remain in code as the built-in
-- fallback (so Claude continues to work without seeding rows).
--
-- Defense against open-redirect abuse:
--   * exact URI match only (no regex)
--   * registration requires owner/admin role (enforced in API route)
--   * unique constraint on redirect_uri so two users can't both claim it
--   * revoke flips revoked_at instead of deleting (preserves audit trail)
CREATE TABLE public.oauth_client_registrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID REFERENCES auth.users ON DELETE CASCADE NOT NULL,
  client_name TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at TIMESTAMPTZ
);

-- Only one active registration per URI. Allows the same URI to be
-- re-registered after revocation (partial unique index).
CREATE UNIQUE INDEX oauth_client_registrations_uri_active
  ON public.oauth_client_registrations (redirect_uri)
  WHERE revoked_at IS NULL;

CREATE INDEX oauth_client_registrations_user_id_idx
  ON public.oauth_client_registrations (user_id);

ALTER TABLE public.oauth_client_registrations ENABLE ROW LEVEL SECURITY;

-- Users see and manage only their own registrations.
CREATE POLICY "oauth_client_registrations_select_own"
  ON public.oauth_client_registrations FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "oauth_client_registrations_insert_own"
  ON public.oauth_client_registrations FOR INSERT
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "oauth_client_registrations_update_own"
  ON public.oauth_client_registrations FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE POLICY "oauth_client_registrations_delete_own"
  ON public.oauth_client_registrations FOR DELETE
  USING (user_id = auth.uid());

CREATE TRIGGER oauth_client_registrations_set_updated_at
  BEFORE UPDATE ON public.oauth_client_registrations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
