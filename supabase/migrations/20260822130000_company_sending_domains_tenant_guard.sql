-- Tenant writes to company_sending_domains may only open a pending claim and
-- edit the sender presentation (sender_local_part, sender_name, enabled).
-- Everything that proves domain ownership (domain, status, resend_domain_id,
-- dns_records, verified_at, last_checked_at) is written by the server with the
-- service role after talking to Resend.
--
-- Without this, an owner/admin holding the opt-in grant could insert
-- {domain: <the platform's own sender domain>, status: 'verified'} straight
-- through PostgREST (RLS only checks membership), and resolveInvoiceSender()
-- would then send that company's invoice mail as the platform itself with an
-- arbitrary local part and display name. The app-side validation in the
-- claim route is not a security boundary; this trigger is.
--
-- Trust model (same idiom as 20260807130000 / 20260813162752): a request is
-- trusted when it carries the service_role JWT claim, or when it carries no
-- PostgREST claims at all (migrations, pg-real superuser seeds, direct DB
-- sessions). Anything else is a tenant.

ALTER TABLE public.company_sending_domains
  DROP CONSTRAINT IF EXISTS company_sending_domains_domain_shape;
ALTER TABLE public.company_sending_domains
  ADD CONSTRAINT company_sending_domains_domain_shape CHECK (
    length(domain) BETWEEN 4 AND 253
    AND domain = lower(domain)
    AND domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
  );

-- Local part must be a dot-atom: atoms of [a-z0-9_-] separated by single
-- dots, no leading/trailing/consecutive dots (mirrors SENDER_LOCAL_PART_PATTERN
-- in lib/email/domain-name.ts). Replaces the looser inline CHECK from
-- 20260822120000 under the same auto-generated constraint name.
ALTER TABLE public.company_sending_domains
  DROP CONSTRAINT IF EXISTS company_sending_domains_sender_local_part_check;
ALTER TABLE public.company_sending_domains
  ADD CONSTRAINT company_sending_domains_sender_local_part_check CHECK (
    length(sender_local_part) BETWEEN 1 AND 64
    AND sender_local_part ~ '^[a-z0-9_-]+(\.[a-z0-9_-]+)*$'
  );

-- The webhook resolves rows by Resend domain id with maybeSingle(): state the
-- one-row assumption in the schema.
DROP INDEX IF EXISTS public.idx_company_sending_domains_resend_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_company_sending_domains_resend_id
  ON public.company_sending_domains (resend_domain_id)
  WHERE resend_domain_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.guard_company_sending_domain_tenant_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_claims jsonb;
  v_role text;
BEGIN
  v_claims := nullif(current_setting('request.jwt.claims', true), '')::jsonb;
  v_role := coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    v_claims->>'role'
  );

  -- Trusted: service role, or no PostgREST context at all.
  IF coalesce(v_role, '') = 'service_role'
     OR (v_claims IS NULL AND v_role IS NULL) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'pending'
       OR NEW.resend_domain_id IS NOT NULL
       OR NEW.dns_records IS NOT NULL
       OR NEW.verified_at IS NOT NULL
       OR NEW.last_checked_at IS NOT NULL THEN
      RAISE EXCEPTION 'company_sending_domains: a tenant claim starts as pending; verification state is written by the server'
        USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.domain IS DISTINCT FROM OLD.domain
     OR NEW.status IS DISTINCT FROM OLD.status
     OR NEW.resend_domain_id IS DISTINCT FROM OLD.resend_domain_id
     OR NEW.dns_records IS DISTINCT FROM OLD.dns_records
     OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
     OR NEW.last_checked_at IS DISTINCT FROM OLD.last_checked_at THEN
    RAISE EXCEPTION 'company_sending_domains: domain and verification state are server-managed; tenants may only change sender_local_part, sender_name and enabled'
      USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.guard_company_sending_domain_tenant_write() FROM PUBLIC;

DROP TRIGGER IF EXISTS guard_company_sending_domain_tenant_write ON public.company_sending_domains;
CREATE TRIGGER guard_company_sending_domain_tenant_write
  BEFORE INSERT OR UPDATE ON public.company_sending_domains
  FOR EACH ROW EXECUTE FUNCTION public.guard_company_sending_domain_tenant_write();

COMMENT ON FUNCTION public.guard_company_sending_domain_tenant_write() IS
  'Tenant JWTs may only open a pending sending-domain claim and edit sender presentation; verification state is service-role only.';

NOTIFY pgrst, 'reload schema';
