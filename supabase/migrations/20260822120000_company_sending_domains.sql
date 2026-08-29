-- Custom outbound sending domains for invoice email (opt-in per company).
--
-- Today every invoice email leaves from the platform's shared sender
-- ("<Company> via <App> <noreply@platform>"). This table lets a company verify
-- its own domain via Resend's domain API (sending capability only) and, once
-- status = 'verified' AND enabled, send invoice mail as
-- "<sender_name> <sender_local_part@domain>" so DKIM/DMARC align with the
-- company's own domain at the recipient's filter.
--
-- Design notes:
--   * Mirrors company_inbound_domains (20260701090000): same lifecycle
--     (claim -> DNS -> verified), same RLS shape, same audit trigger. Kept as
--     a separate table because the two are different Resend domain profiles
--     (sending-only vs receiving-only) with different failure consequences.
--   * No user_id column: the row is company configuration that must outlive
--     the user who created it.
--   * Global unique on lower(domain): one company owns a sending domain
--     across all tenants. One sending domain per company (v1).
--   * Only rows with status = 'verified' AND enabled = true ever change the
--     From header. Everything else falls back to the platform sender, so a
--     DNS blip can never stop invoice mail.
--   * The feature itself is gated behind a per-company capability grant
--     (CAPABILITY.custom_sender_domain) resolved application-side; the table
--     carries no opinion about who may use it.

-- =============================================================================
-- 1. Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_sending_domains (
  id                 uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Lowercased, punycoded hostname (validated app-side before insert).
  domain             text NOT NULL,
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'verified', 'failed')),
  -- Local part of the From address: <sender_local_part>@<domain>.
  sender_local_part  text NOT NULL DEFAULT 'faktura'
                       CHECK (sender_local_part ~ '^[a-z0-9][a-z0-9._-]{0,63}$'),
  -- Optional display name; NULL means "use the company name".
  sender_name        text
                       CHECK (sender_name IS NULL OR (length(sender_name) BETWEEN 1 AND 120)),
  -- Pause without removing the domain (DNS stays verified in Resend).
  enabled            boolean NOT NULL DEFAULT true,
  -- Resend's domain id + the DNS records the user must publish (records[]
  -- from the Resend API response, rendered verbatim in the UI).
  resend_domain_id   text,
  dns_records        jsonb,
  verified_at        timestamptz,
  last_checked_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- A domain belongs to exactly one company, across all tenants.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_sending_domains_domain
  ON public.company_sending_domains (lower(domain));

-- One sending domain per company (v1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_sending_domains_company
  ON public.company_sending_domains (company_id);

-- Webhook lookups resolve rows by Resend's domain id.
CREATE INDEX IF NOT EXISTS idx_company_sending_domains_resend_id
  ON public.company_sending_domains (resend_domain_id)
  WHERE resend_domain_id IS NOT NULL;

-- =============================================================================
-- 2. RLS: SELECT for members, writes for owner/admin only
--    (same shape as company_inbound_domains)
-- =============================================================================

ALTER TABLE public.company_sending_domains ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "company_sending_domains_select" ON public.company_sending_domains;
CREATE POLICY "company_sending_domains_select" ON public.company_sending_domains
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "company_sending_domains_insert" ON public.company_sending_domains;
CREATE POLICY "company_sending_domains_insert" ON public.company_sending_domains
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "company_sending_domains_update" ON public.company_sending_domains;
CREATE POLICY "company_sending_domains_update" ON public.company_sending_domains
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "company_sending_domains_delete" ON public.company_sending_domains;
CREATE POLICY "company_sending_domains_delete" ON public.company_sending_domains
  FOR DELETE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

-- =============================================================================
-- 3. Triggers
-- =============================================================================

DROP TRIGGER IF EXISTS company_sending_domains_updated_at ON public.company_sending_domains;
CREATE TRIGGER company_sending_domains_updated_at
  BEFORE UPDATE ON public.company_sending_domains
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Sending-domain changes alter who a company's invoice mail claims to come
-- from: audit them.
DROP TRIGGER IF EXISTS audit_company_sending_domains ON public.company_sending_domains;
CREATE TRIGGER audit_company_sending_domains
  AFTER INSERT OR UPDATE OR DELETE ON public.company_sending_domains
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
