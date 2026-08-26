-- WhatsApp channel, part 1/3: phone identity.
--
-- One shared Accounted WhatsApp number serves every tenant, so an inbound
-- message identifies its sender only by phone number. These tables bind a
-- verified phone to an auth user (whatsapp_phone_links) via a one-time code
-- the user sends TO the number (whatsapp_link_codes, invite-token pattern:
-- raw code exists only in the user's chat, sha256 hex stored).
--
-- whatsapp_phone_links is USER-scoped, not company-scoped (like
-- user_preferences): a link belongs to a person; which company a receipt
-- lands in is resolved per message. Phone PII: phone_hash is an
-- HMAC-SHA256 with a server-side pepper (plain sha256 is brute-forceable
-- over the ~10^9 phone number space), phone_enc is AES-256-GCM
-- (lib/auth/bankid.ts codec), phone_masked is display-only.

CREATE TABLE IF NOT EXISTS public.whatsapp_phone_links (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  phone_hash         text NOT NULL,
  phone_enc          text NOT NULL,
  phone_masked       text NOT NULL,
  wa_profile_name    text,

  -- Which company receipts land in when the sender belongs to several and
  -- the conversation has no fresher pin. Both nullable on purpose.
  default_company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  last_company_id    uuid REFERENCES public.companies(id) ON DELETE SET NULL,

  verified_at        timestamptz NOT NULL DEFAULT now(),
  revoked_at         timestamptz,
  -- STOP keyword: bot goes silent but the binding survives (start re-opens).
  muted_at           timestamptz,
  last_message_at    timestamptz,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One ACTIVE link per phone and per user; revoked rows stay as history.
CREATE UNIQUE INDEX whatsapp_phone_links_phone_active
  ON public.whatsapp_phone_links (phone_hash) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX whatsapp_phone_links_user_active
  ON public.whatsapp_phone_links (user_id) WHERE revoked_at IS NULL;

ALTER TABLE public.whatsapp_phone_links ENABLE ROW LEVEL SECURITY;

-- The user sees and manages their own binding (settings panel: status,
-- default company, revoke). INSERT is service-role only: a binding is
-- created exclusively by the webhook after code verification. No DELETE:
-- revocation (revoked_at) keeps the trail auditable.
CREATE POLICY "whatsapp_phone_links_select_own"
  ON public.whatsapp_phone_links
  FOR SELECT
  USING (user_id = auth.uid());

CREATE POLICY "whatsapp_phone_links_update_own"
  ON public.whatsapp_phone_links
  FOR UPDATE
  USING (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());

CREATE TRIGGER whatsapp_phone_links_updated_at
  BEFORE UPDATE ON public.whatsapp_phone_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- One-time link codes (10-minute TTL, single use). Raw code never stored.
CREATE TABLE IF NOT EXISTS public.whatsapp_link_codes (
  id         uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  code_hash  text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  used_at    timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_whatsapp_link_codes_user
  ON public.whatsapp_link_codes (user_id);

ALTER TABLE public.whatsapp_link_codes ENABLE ROW LEVEL SECURITY;
-- Deliberately NO policies: minting happens in the authenticated route via
-- the service client, resolution happens in the webhook via the service
-- client. Nothing user-facing ever reads a code hash.

CREATE TRIGGER whatsapp_link_codes_updated_at
  BEFORE UPDATE ON public.whatsapp_link_codes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
