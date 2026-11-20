-- Attest policy for supplier invoices (attestflöde).
--
-- Until now attest was one click by anyone with write access, and an
-- unattested invoice only warned at payment. A company can now switch on a
-- policy: an amount from which attest is required (or always), who attests,
-- whether one of them is enough ('any') or every one of them must ('all'),
-- and whether the person who registered the invoice may attest it too (four
-- eyes when not). While the policy requires attest and it is not given, the
-- invoice is left out of bank payments and payment files.
--
-- Three tables and two columns:
--   company_attest_policies         one row per company, written by owners and
--                                   admins (the settings section "Attest").
--   supplier_invoice_attestations   the audit trail: every approval and
--                                   rejection, who, when, from where, and the
--                                   comment. Append only. supplier_invoices.
--                                   approved_at/approved_by are set when the
--                                   policy is satisfied (any: the first
--                                   approval; all: the last required one).
--   supplier_invoice_attest_links   the mail's Godkänn / Neka link: a token per
--                                   attester per invoice, sha256-hashed at rest,
--                                   7 days, single use. The page at
--                                   /attest/<token> works without a login, the
--                                   posture of bank_connect_invites.
--   supplier_invoices.approved_by   who gave the attest that satisfied it.
--   notification_settings.attest_request_email_enabled
--                                   the attester's own switch for the mail.
--
-- The rules (who may attest, whether an invoice needs attest, whether it is
-- satisfied) live in src/lib/supplier-invoices/attest-policy.ts; kontantmetoden
-- has no attest step and the policy does not apply there.
--
-- pg-test: covered-by tests/pg/supplier-invoice-attest-policy.pg.test.ts

-- 1. The policy ---------------------------------------------------------------
CREATE TABLE public.company_attest_policies (
  company_id           uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  enabled              boolean NOT NULL DEFAULT false,
  -- Attest is required for invoices at or above this amount in SEK; NULL means always.
  threshold_amount     numeric(14,2) CHECK (threshold_amount IS NULL OR threshold_amount >= 0),
  mode                 text NOT NULL DEFAULT 'any' CHECK (mode IN ('any', 'all')),
  -- Company members who attest (non-viewers, checked by the server on save).
  attesters            uuid[] NOT NULL DEFAULT '{}'
                       CHECK (cardinality(attesters) <= 50 AND array_position(attesters, NULL) IS NULL),
  preparer_may_attest  boolean NOT NULL DEFAULT false,
  updated_by           uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT company_attest_policies_enabled_needs_attester CHECK (NOT enabled OR cardinality(attesters) >= 1)
);

COMMENT ON TABLE public.company_attest_policies IS
  'Attest policy for supplier invoices, one row per company: on/off, the SEK amount from which attest is required (NULL = always), the attesters, any or all of them, and whether the registrant may attest. Owners and admins write it.';
COMMENT ON COLUMN public.company_attest_policies.threshold_amount IS
  'Attest is required for supplier invoices whose total in SEK is at or above this amount. NULL = every invoice.';
COMMENT ON COLUMN public.company_attest_policies.mode IS
  '''any'': one approval by an attester satisfies the policy; ''all'': every attester who may attest the invoice must approve.';
COMMENT ON COLUMN public.company_attest_policies.attesters IS
  'User ids of the company members who attest. A member who leaves the company or becomes a viewer stops counting.';
COMMENT ON COLUMN public.company_attest_policies.preparer_may_attest IS
  'False (the default): the person who registered an invoice cannot attest it (four eyes).';

CREATE TRIGGER company_attest_policies_updated_at
  BEFORE UPDATE ON public.company_attest_policies
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.company_attest_policies ENABLE ROW LEVEL SECURITY;

CREATE POLICY "company_attest_policies_select_member" ON public.company_attest_policies
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "company_attest_policies_insert_admin" ON public.company_attest_policies
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id));
CREATE POLICY "company_attest_policies_update_admin" ON public.company_attest_policies
  FOR UPDATE USING (public.user_is_company_admin(company_id)) WITH CHECK (public.user_is_company_admin(company_id));

GRANT SELECT, INSERT, UPDATE ON TABLE public.company_attest_policies TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_attest_policies TO service_role;
-- no-grant: anon on public.company_attest_policies (company configuration, members only)

-- 2. The audit trail ----------------------------------------------------------
CREATE TABLE public.supplier_invoice_attestations (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  supplier_invoice_id  uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,
  -- The attester. The company keeps the record of who attested.
  user_id              uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  decision             text NOT NULL CHECK (decision IN ('approved', 'rejected')),
  comment              text CHECK (comment IS NULL OR char_length(comment) <= 1000),
  -- Where the decision was made: the app, the mail's link (no login), the API or an approved agent operation.
  source               text NOT NULL DEFAULT 'app' CHECK (source IN ('app', 'email_link', 'api', 'mcp')),
  decided_at           timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.supplier_invoice_attestations IS
  'Every attest decision on a supplier invoice: who approved or rejected it, when, from where and with what comment. Append only, written by the server. A rejection starts a new round: approvals before it no longer count.';
COMMENT ON COLUMN public.supplier_invoice_attestations.source IS
  'app (signed in), email_link (the mail''s Godkänn / Neka link, no login), api (an API key) or mcp (an approved agent operation).';

CREATE INDEX supplier_invoice_attestations_invoice ON public.supplier_invoice_attestations (supplier_invoice_id, decided_at);
CREATE INDEX supplier_invoice_attestations_company ON public.supplier_invoice_attestations (company_id, decided_at DESC);

ALTER TABLE public.supplier_invoice_attestations ENABLE ROW LEVEL SECURITY;

-- Members read the trail; nobody writes it from a browser session: the
-- server records a decision as the service role after its own checks, and
-- nothing ever updates or deletes one.
CREATE POLICY "supplier_invoice_attestations_select_member" ON public.supplier_invoice_attestations
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.supplier_invoice_attestations TO authenticated;
GRANT SELECT, INSERT ON TABLE public.supplier_invoice_attestations TO service_role;
-- no-grant: anon on public.supplier_invoice_attestations (audit trail, members only)

-- 3. The mail's link ----------------------------------------------------------
CREATE TABLE public.supplier_invoice_attest_links (
  id                   uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  supplier_invoice_id  uuid NOT NULL REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,
  -- The attester the link speaks for: a decision through it is recorded as theirs.
  attester_user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash           text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at           timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  mail_sent_at         timestamptz,
  consumed_at          timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.supplier_invoice_attest_links IS
  'The Godkänn / Neka link in the attest mail: one per attester per invoice, valid 7 days, consumed by the decision (or by a rejection that ends the round). Token hashed at rest. Service role only.';
COMMENT ON COLUMN public.supplier_invoice_attest_links.token_hash IS
  'sha256 of the clear token, which exists only in the URL (and the mail that carried it).';

-- One open link per attester per invoice: a new one consumes the old first.
CREATE UNIQUE INDEX supplier_invoice_attest_links_one_open
  ON public.supplier_invoice_attest_links (supplier_invoice_id, attester_user_id)
  WHERE consumed_at IS NULL;
CREATE INDEX supplier_invoice_attest_links_company ON public.supplier_invoice_attest_links (company_id, created_at DESC);

ALTER TABLE public.supplier_invoice_attest_links ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_invoice_attest_links TO service_role;
-- no-grant: authenticated on public.supplier_invoice_attest_links (token credentials: the token routes run as the service role)
-- no-grant: anon on public.supplier_invoice_attest_links (token credentials: the token routes run as the service role)

-- 4. Who gave the attest ------------------------------------------------------
ALTER TABLE public.supplier_invoices
  ADD COLUMN IF NOT EXISTS approved_by uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.supplier_invoices.approved_by IS
  'Who gave the attest that set approved_at (with an attest policy in mode all: the last required approval). NULL on rows attested before 2026-10-14; supplier_invoice_attestations holds every decision.';

-- 5. The attester's own switch for the mail -------------------------------------
ALTER TABLE public.notification_settings
  ADD COLUMN IF NOT EXISTS attest_request_email_enabled boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.notification_settings.attest_request_email_enabled IS
  'Per-user switch for the mail with Godkänn / Neka links when a supplier invoice waits for the user''s attest. Default on.';

NOTIFY pgrst, 'reload schema';
