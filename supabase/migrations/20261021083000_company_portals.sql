-- pg-test: covered-by tests/pg/company-portals.pg.test.ts
-- =============================================================================
-- company_portals: where one company's own suppliers keep their invoices
--
-- The portal directory (src/lib/receipt-hunt/portal-directory.ts) knows the
-- billing page of a few global vendors that never mail an invoice. Every other
-- supplier that keeps its invoices behind a login (Telia, Ellevio, a local
-- landlord's tenant page) could only be uploaded by hand. A person now says
-- so once, from the Inkorg: "this supplier's invoices are in a portal, here is
-- the link". One row per supplier and company.
--
-- The supplier is the purchase's own counterparty, never typed: the server
-- derives counterparty_key from the bank row with the same fold the Inkorg
-- already uses to say two bank rows are one counterparty (bankKeyOf in
-- src/lib/inkorg/expectations.ts, normalizeForMatch). It is matched at read
-- time, so every purchase from that supplier, earlier and later, finds it.
--
-- Only a link: no username, no password, nothing that logs in. The url is
-- https only, without userinfo and without a query string (where one-time
-- tokens and sessions live); src/lib/receipt-hunt/company-portals.ts
-- (normalizePortalUrl) applies the rule and the CHECKs below hold it.
-- =============================================================================

CREATE TABLE public.company_portals (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- normalizeForMatch of the bank row's merchant name, else its text.
  counterparty_key text NOT NULL CHECK (char_length(counterparty_key) BETWEEN 3 AND 200),
  -- The supplier as the Inkorg names the purchase ("Telia"); the Portaler row's label.
  vendor_name text NOT NULL CHECK (char_length(btrim(vendor_name)) BETWEEN 1 AND 80),
  url text NOT NULL CHECK (
    char_length(url) <= 2048
    AND url ~ '^https://[^/?#@[:space:]]+\.[^/?#@[:space:]]+'
    AND url !~ '^[^#]*\?'
    AND url !~ '[[:space:]]'
  ),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_portals_counterparty_key UNIQUE (company_id, counterparty_key)
);

COMMENT ON TABLE public.company_portals IS
  'Per company: the page where a supplier keeps its invoices behind a login, keyed by the counterparty its bank rows fold to. A link only, never credentials.';
COMMENT ON COLUMN public.company_portals.counterparty_key IS
  'normalizeForMatch (src/lib/documents/core-receipt-matcher.ts) of the bank row the portal was added from; a purchase whose fold contains it as whole words resolves to this portal.';
COMMENT ON COLUMN public.company_portals.url IS
  'https only, no userinfo, no query string (normalizePortalUrl in src/lib/receipt-hunt/company-portals.ts).';

ALTER TABLE public.company_portals ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_portals TO service_role;
GRANT SELECT, INSERT, DELETE ON TABLE public.company_portals TO authenticated;
-- A member changes a portal's link and nothing else: which supplier it is
-- and who added it stay as they were.
GRANT UPDATE (url) ON TABLE public.company_portals TO authenticated;
-- no-grant: anon on public.company_portals (a company's supplier links; no public surface reads them)

-- Members read; a writing member adds in their own name, changes the link
-- and removes the portal. Viewers and strangers do none of it.
CREATE POLICY "view own-company company_portals"
  ON public.company_portals FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company company_portals"
  ON public.company_portals FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND created_by = auth.uid()
  );

CREATE POLICY "update own-company company_portals"
  ON public.company_portals FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  );

CREATE POLICY "delete own-company company_portals"
  ON public.company_portals FOR DELETE
  USING (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_portals
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER company_portals_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.company_portals
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER set_updated_at_company_portals
  BEFORE UPDATE ON public.company_portals
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_company_portals
  AFTER INSERT OR UPDATE OR DELETE ON public.company_portals
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
