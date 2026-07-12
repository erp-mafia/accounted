-- Skatteverket system-auth (ombud) connection state, one row per company and
-- environment.
--
-- The hybrid auth model: interactive submissions keep the personal BankID
-- flow, background reads (skattekonto sync, kvittens polling, beslut checks)
-- move to Accounted's own organization certificate (OAuth2 Client Credentials
-- Grant). A company authorizes that once by granting Accounted's org number a
-- behorighet ("Juridiskt lasombud", "Momsdeklaration, ombud") in
-- Skatteverket's Ombud och behorigheter e-service. This table records what a
-- verification probe has established about those grants, so the crons can
-- enumerate companies whose background reads can run on system credentials.
--
-- Writes go through the service-role client in
-- extensions/general/skatteverket/lib/connection-store.ts (probes run with
-- system credentials server-side; the user's identity and role are enforced
-- at the route layer). User sessions only ever SELECT.

CREATE TABLE public.skatteverket_company_connections (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id UUID NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  environment TEXT NOT NULL CHECK (environment IN ('test', 'production')),

  -- Normalized 12-digit org number snapshot at probe time; probes address
  -- SKV by org number, so record exactly what was verified.
  org_number TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'partial', 'verified', 'revoked', 'error')),

  -- One column pair per behorighet type so the crons can filter with an
  -- index. lasombud = "Juridiskt lasombud" (read APIs: skattekonto, AGI
  -- kvittenser); moms_ombud = "Momsdeklaration, ombud" (moms draft/read).
  lasombud_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (lasombud_status IN ('unknown', 'granted', 'denied', 'error')),
  lasombud_checked_at TIMESTAMPTZ,
  moms_ombud_status TEXT NOT NULL DEFAULT 'unknown'
    CHECK (moms_ombud_status IN ('unknown', 'granted', 'denied', 'error')),
  moms_ombud_checked_at TIMESTAMPTZ,

  -- First time the aggregate status reached 'verified'.
  verified_at TIMESTAMPTZ,
  last_probe_at TIMESTAMPTZ,
  -- Raw probe classification for diagnostics (statuses, felkoder).
  last_probe_detail JSONB,
  last_error TEXT,

  created_by UUID REFERENCES auth.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (company_id, environment)
);

ALTER TABLE public.skatteverket_company_connections ENABLE ROW LEVEL SECURITY;

-- Members can see their company's connection state (settings panel).
-- No INSERT/UPDATE/DELETE policies: all writes go through the service-role
-- client in connection-store.ts.
CREATE POLICY "Members can view skv company connections"
  ON public.skatteverket_company_connections FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

-- Cron enumeration: verified/partial rows per environment.
CREATE INDEX idx_skv_company_connections_cron
  ON public.skatteverket_company_connections (environment, status)
  WHERE status IN ('verified', 'partial');

CREATE TRIGGER update_skv_company_connections_updated_at
  BEFORE UPDATE ON public.skatteverket_company_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
