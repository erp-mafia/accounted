-- Secure payslip links.
--
-- Payslips are delivered to employees as emailed LINKS (not PDF attachments —
-- salary data + personnummer must not sit in inboxes). The link token is a
-- credential with a lifecycle (rotation on resend, revocation on correction,
-- expiry), so it lives in its own table — NOT on salary_payslip_deliveries,
-- which is an append-only BFL 7 kap. audit log of delivery attempts.
--
-- One live link per (salary_run_id, employee_id); resending rotates the
-- token (old hash invalidated by overwrite). Raw tokens are never stored —
-- sha256 hex only. The public resolve path uses the service role; there are
-- deliberately NO anon policies.

CREATE TABLE IF NOT EXISTS public.salary_payslip_links (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id         uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  salary_run_id      uuid NOT NULL REFERENCES public.salary_runs(id) ON DELETE CASCADE,
  employee_id        uuid NOT NULL REFERENCES public.employees(id) ON DELETE RESTRICT,
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- sha256 hex of the raw token; the raw token exists only in the email.
  token_hash         text NOT NULL UNIQUE,

  expires_at         timestamptz NOT NULL,
  revoked_at         timestamptz,

  last_accessed_at   timestamptz,
  access_count       integer NOT NULL DEFAULT 0,

  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  UNIQUE (salary_run_id, employee_id)
);

ALTER TABLE public.salary_payslip_links ENABLE ROW LEVEL SECURITY;

CREATE POLICY "salary_payslip_links_select"
  ON public.salary_payslip_links
  FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "salary_payslip_links_insert"
  ON public.salary_payslip_links
  FOR INSERT
  WITH CHECK (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "salary_payslip_links_update"
  ON public.salary_payslip_links
  FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()));

-- No DELETE policy — links are revoked (revoked_at), never deleted, so the
-- trail of what was ever reachable stays auditable.

CREATE INDEX idx_payslip_links_run
  ON public.salary_payslip_links (salary_run_id);

CREATE INDEX idx_payslip_links_company
  ON public.salary_payslip_links (company_id);

CREATE TRIGGER salary_payslip_links_updated_at
  BEFORE UPDATE ON public.salary_payslip_links
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
