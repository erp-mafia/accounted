-- Custom inbound email domains for the invoice-inbox extension.
--
-- Today every company receives supplier invoices on a generated address on
-- the single shared Resend inbound domain (company_inboxes.local_part @
-- RESEND_INBOUND_DOMAIN). This table lets a company verify its own domain
-- (or subdomain) via Resend's domain API — once status = 'verified', the
-- inbound webhook routes mail for ANY local part on that domain to the
-- company (catch-all), with no forwarding step.
--
-- Design notes:
--   * Separate table (not columns on company_inboxes): domain verification
--     is a domain lifecycle, while company_inboxes models rotating addresses
--     on the shared domain. Keeping them apart leaves rotate_company_inbox()
--     and its unique indexes untouched.
--   * No user_id column — mirrors company_inboxes. The row is company
--     configuration that must outlive the user who created it; a cascade on
--     user deletion would silently drop a working mail route.
--   * Global unique on lower(domain): one company owns a domain, across all
--     tenants. Rows are hard-deleted on removal, which frees the name.
--   * One custom domain per company (unique on company_id) — v1 scope;
--     relaxing later is a constraint drop, not a remodel.
--   * Only rows with status = 'verified' ever route mail. 'pending' claims
--     must never receive email — DNS verification is the ownership proof.

-- =============================================================================
-- 1. Table
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.company_inbound_domains (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Lowercased, punycoded hostname (validated app-side before insert).
  domain           text NOT NULL,
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'verified', 'failed')),
  -- Resend's domain id + the DNS records the user must publish (records[]
  -- from the Resend API response, rendered verbatim in the UI).
  resend_domain_id text,
  dns_records      jsonb,
  verified_at      timestamptz,
  last_checked_at  timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- A domain belongs to exactly one company, across all tenants.
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_inbound_domains_domain
  ON public.company_inbound_domains (lower(domain));

-- One custom domain per company (v1).
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_inbound_domains_company
  ON public.company_inbound_domains (company_id);

-- =============================================================================
-- 2. RLS — SELECT for members, writes for owner/admin only
--    (mirrors the tightened company_inboxes policies from
--    20260420190000_inbox_hardening.sql)
-- =============================================================================

ALTER TABLE public.company_inbound_domains ENABLE ROW LEVEL SECURITY;

-- Idempotent: staging gets this DDL applied manually ahead of the branch
-- merge, so a later replay of this migration must not fail on existing
-- policies/triggers.
DROP POLICY IF EXISTS "company_inbound_domains_select" ON public.company_inbound_domains;
CREATE POLICY "company_inbound_domains_select" ON public.company_inbound_domains
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY IF EXISTS "company_inbound_domains_insert" ON public.company_inbound_domains;
CREATE POLICY "company_inbound_domains_insert" ON public.company_inbound_domains
  FOR INSERT WITH CHECK (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "company_inbound_domains_update" ON public.company_inbound_domains;
CREATE POLICY "company_inbound_domains_update" ON public.company_inbound_domains
  FOR UPDATE USING (
    company_id IN (
      SELECT cm.company_id FROM public.company_members cm
      WHERE cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  );

DROP POLICY IF EXISTS "company_inbound_domains_delete" ON public.company_inbound_domains;
CREATE POLICY "company_inbound_domains_delete" ON public.company_inbound_domains
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

DROP TRIGGER IF EXISTS company_inbound_domains_updated_at ON public.company_inbound_domains;
CREATE TRIGGER company_inbound_domains_updated_at
  BEFORE UPDATE ON public.company_inbound_domains
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- Domain claims change where a company's mail is routed — audit them.
DROP TRIGGER IF EXISTS audit_company_inbound_domains ON public.company_inbound_domains;
CREATE TRIGGER audit_company_inbound_domains
  AFTER INSERT OR UPDATE OR DELETE ON public.company_inbound_domains
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
