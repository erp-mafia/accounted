-- Migration: brands table
--
-- White-label foundation slice (WL-01/WL-02/WL-12 resolutions,
-- dev_docs/white-label/): a brand is a byrå team's white-label identity.
-- One brand per team (unique team_id), one mutable domain per brand (unique
-- domain), row presence = live. Brand rows are ops-managed via the service
-- role in v1: no INSERT/UPDATE/DELETE policies on purpose. Host resolution
-- (lib/branding/resolve.ts) uses the cookieless service client and bypasses
-- RLS by design, because anonymous visitors on a brand domain need the brand
-- before login. The single SELECT policy lets members of the owning team read
-- their own brand (e.g. a future cockpit surface).
--
-- Color CHECKs mirror the invoice branding pattern
-- (20260526120200_invoice_branding.sql): a regex gate so invalid values never
-- reach the renderer. chrome_color is an explicit ops override; NULL means
-- the chrome tone is derived from brand_color at runtime (WL-02 model A).

CREATE TABLE public.brands (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id              uuid NOT NULL UNIQUE REFERENCES public.teams(id) ON DELETE CASCADE,

  -- Lowercase hostname only: no scheme, no slash, no port, no uppercase.
  domain               text NOT NULL UNIQUE,

  app_name             text NOT NULL,
  logo_url             text,
  brand_color          text NOT NULL,
  chrome_color         text,
  font_key             text NOT NULL DEFAULT 'default',

  -- Email identity (WL-01: the brand carries email sender identity; no
  -- verified sender domain means the "Partner via Accounted" fallback,
  -- email never blocks go-live).
  support_email        text NOT NULL,
  auth_email_from      text,
  sender_domain        text,
  resend_domain_id     text,
  sender_domain_status text NOT NULL DEFAULT 'unverified',

  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT brands_domain_format
    CHECK (domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$'),
  CONSTRAINT brands_brand_color_format
    CHECK (brand_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT brands_chrome_color_format
    CHECK (chrome_color IS NULL OR chrome_color ~ '^#[0-9A-Fa-f]{6}$'),
  CONSTRAINT brands_sender_domain_status_check
    CHECK (sender_domain_status IN ('unverified', 'pending', 'verified', 'failed'))
);

COMMENT ON TABLE public.brands IS
  'A brand is a byrå team''s white-label identity: the domain the app is '
  'served on, the app name, logo, brand color (chrome tone derived unless '
  'chrome_color overrides it), font pair from the curated menu, and the email '
  'sender identity. Exactly one brand per team (unique team_id) and one '
  'mutable domain per brand (unique domain). Row presence means live: there '
  'is no active flag; preview happens by pointing domain at a controlled '
  'subdomain, go-live is one UPDATE, and deleting the row reverts the team''s '
  'companies to the canonical Accounted appearance. Rows are ops-managed via '
  'the service role in v1; team members have read-only visibility.';

-- =============================================================================
-- RLS
-- =============================================================================

ALTER TABLE public.brands ENABLE ROW LEVEL SECURITY;

-- Members of the owning team may read their brand. No write policies: brand
-- rows are created/updated/deleted by ops through the service role in v1.
CREATE POLICY "brands_select" ON public.brands
  FOR SELECT USING (team_id IN (SELECT public.user_team_ids()));

-- =============================================================================
-- Triggers
-- =============================================================================

CREATE TRIGGER brands_updated_at
  BEFORE UPDATE ON public.brands
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
