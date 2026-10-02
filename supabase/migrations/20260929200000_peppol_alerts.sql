-- Peppol health alerts: one row per problem already reported.
-- pg-test: tests/pg/peppol-alerts.pg.test.ts
--
-- Every Peppol failure mode used to be silent: a delivery the access point
-- refused, a delivery nobody heard back about, a retryable failure nobody
-- retried, an inbound document no company received. The health check in
-- lib/invoices/peppol-health.ts (run at the end of the outbound status cron)
-- finds them and mails the sender of a failed invoice and the team.
--
-- A problem must be reported once, not every fifteen minutes, and two
-- overlapping cron runs must not both report it. The check claims each
-- problem with INSERT ... ON CONFLICT (kind, ref_id) DO NOTHING RETURNING and
-- mails only what this run claimed. A mail that fails deletes the claims it
-- covered, so the next run reports them again.
--
--   kind                  ref_id
--   delivery_failed       peppol_deliveries.id
--   delivery_stuck        peppol_deliveries.id
--   delivery_retry_stuck  peppol_deliveries.id
--   inbound_unrouted      peppol_inbound_documents.id
--
-- ref_id has no foreign key: it points at one of two tables depending on the
-- kind, and both are retained records that are never deleted. company_id is
-- null only for an inbound document that reached no company, which is the
-- problem being reported; every delivery belongs to a company.
--
-- Access: service role only. RLS on with no policies and no grants for anon
-- or authenticated, like api_key_companies: the cron is the only reader and
-- writer, and a member has no use for the claim ledger.
--
-- The same change surfaces a failed delivery in the product (the Att göra row
-- and the invoice list's chip). peppol_deliveries is not granted to
-- authenticated, so the one definition of "an invoice whose latest delivery
-- failed" is peppol_failed_invoice_ids() below: SECURITY DEFINER, narrow
-- (invoice ids only, capped), and empty unless the caller is a member of the
-- company. The request paths call it on the user's own session client; no
-- request path reads peppol_deliveries with the service role.

CREATE TABLE public.peppol_alerts (
  kind       text NOT NULL CHECK (kind IN (
               'delivery_failed',
               'delivery_stuck',
               'delivery_retry_stuck',
               'inbound_unrouted'
             )),
  ref_id     uuid NOT NULL,
  company_id uuid REFERENCES public.companies(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, ref_id),
  CONSTRAINT peppol_alerts_company_shape
    CHECK (kind = 'inbound_unrouted' OR company_id IS NOT NULL)
);

CREATE INDEX idx_peppol_alerts_company_id
  ON public.peppol_alerts (company_id);

COMMENT ON TABLE public.peppol_alerts IS
  'One row = one Peppol problem already reported (dedupe claim). The health check claims with INSERT ... ON CONFLICT (kind, ref_id) DO NOTHING RETURNING and mails only what it claimed; a failed mail deletes its claims so the next run retries. ref_id is a peppol_deliveries id (delivery_*) or a peppol_inbound_documents id (inbound_unrouted). Service role only.';

ALTER TABLE public.peppol_alerts ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.peppol_alerts FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.peppol_alerts TO service_role;

-- ---------------------------------------------------------------------------
-- Invoices whose latest Peppol delivery failed.
--
-- The latest delivery of an invoice is its newest by created_at (DISTINCT ON
-- over idx_peppol_deliveries_invoice_created), so a resend that went through
-- hides the earlier failure. It counts when that delivery is 'failed' or
-- 'no_route' and the invoice is still issued and unpaid ('sent' or
-- 'overdue'): a paid, credited or cancelled invoice has nothing left to
-- deliver. Newest failures first, at most p_limit ids (1 to 500).
--
-- Membership: the same predicate as the tenant RLS policies,
-- p_company_id IN (SELECT public.user_company_ids()). A caller who is not a
-- member of the company, or has no auth.uid() (anon, the service role), gets
-- no rows rather than an error. Read-only: no row of peppol_deliveries leaves
-- the function, only invoice ids.

CREATE FUNCTION public.peppol_failed_invoice_ids(
  p_company_id uuid,
  p_limit integer DEFAULT 200
)
RETURNS SETOF uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT latest.invoice_id
  FROM (
    SELECT DISTINCT ON (delivery.invoice_id)
      delivery.invoice_id,
      delivery.status,
      delivery.created_at
    FROM public.peppol_deliveries AS delivery
    WHERE delivery.company_id = p_company_id
      AND p_company_id IN (SELECT public.user_company_ids())
    ORDER BY delivery.invoice_id, delivery.created_at DESC
  ) AS latest
  JOIN public.invoices AS invoice
    ON invoice.id = latest.invoice_id
   AND invoice.company_id = p_company_id
  WHERE latest.status IN ('failed', 'no_route')
    AND invoice.status IN ('sent', 'overdue')
  ORDER BY latest.created_at DESC, latest.invoice_id
  LIMIT least(greatest(coalesce(p_limit, 200), 1), 500)
$$;

COMMENT ON FUNCTION public.peppol_failed_invoice_ids(uuid, integer) IS
  'Ids of the company''s sent or overdue invoices whose latest Peppol delivery (newest by created_at) is failed or no_route, newest first, at most p_limit (1 to 500). Empty unless the caller is a member (user_company_ids()). Feeds the Att göra row and the invoice list chip on the session client.';

REVOKE ALL ON FUNCTION public.peppol_failed_invoice_ids(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.peppol_failed_invoice_ids(uuid, integer) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
