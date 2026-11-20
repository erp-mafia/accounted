-- Priced usage, asked for instead of accepted (src/lib/usage/requests.ts).
--
-- When a company reaches what a month includes, the paid action stops and
-- a person asks for more; an operator opens the charge for the company by
-- writing its usage_consents row. usage_requests keeps those asks: the
-- server writes one per company, kind and day and mails support with the
-- company, the requester and the month's usage.
--
-- Two kinds join the registry: bank_account (live bank accounts above what
-- the plan includes, counted at the month's close) and ai_document
-- (documents our AI read, counted and shown, not billed).
--
-- A statement for a company covered by its byrå's agreement is billed to the
-- byrå by hand: status 'manual', never a Stripe line of its own.

ALTER TABLE public.usage_consents DROP CONSTRAINT usage_consents_kind_check;
ALTER TABLE public.usage_consents ADD CONSTRAINT usage_consents_kind_check
  CHECK (kind IN ('bank_payment', 'peppol_send', 'kivra_send', 'billo_send', 'signing', 'bank_account', 'ai_document'));

ALTER TABLE public.usage_statements DROP CONSTRAINT usage_statements_kind_check;
ALTER TABLE public.usage_statements ADD CONSTRAINT usage_statements_kind_check
  CHECK (kind IN ('bank_payment', 'peppol_send', 'kivra_send', 'billo_send', 'signing', 'bank_account', 'ai_document'));

ALTER TABLE public.usage_statements DROP CONSTRAINT usage_statements_status_check;
ALTER TABLE public.usage_statements ADD CONSTRAINT usage_statements_status_check
  CHECK (status IN ('preview', 'billing', 'billed', 'failed', 'manual'));

CREATE TABLE public.usage_requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('bank_payment', 'peppol_send', 'kivra_send', 'billo_send', 'signing', 'bank_account', 'ai_document')),
  requested_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  message      text CHECK (message IS NULL OR char_length(message) <= 2000),
  created_at   timestamptz NOT NULL DEFAULT now(),
  handled_at   timestamptz,
  CHECK (handled_at IS NULL OR handled_at >= created_at)
);

COMMENT ON TABLE public.usage_requests IS
  'A person asking for more of a priced service than the month includes. Written by the server (POST /api/billing/usage/requests), which mails support; members read their own company''s requests.';
COMMENT ON COLUMN public.usage_requests.handled_at IS
  'When a founder answered the request; an open request (NULL) less than 24 hours old stops a second one for the same kind.';

CREATE INDEX usage_requests_company ON public.usage_requests (company_id, kind, created_at DESC);

ALTER TABLE public.usage_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY usage_requests_select ON public.usage_requests
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- Inserts go through the API route as the service role (it also mails support).
REVOKE ALL ON TABLE public.usage_requests FROM anon, authenticated;
GRANT SELECT ON TABLE public.usage_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_requests TO service_role;
-- no-grant: anon on public.usage_requests (company support requests; no public surface reads them)

NOTIFY pgrst, 'reload schema';
