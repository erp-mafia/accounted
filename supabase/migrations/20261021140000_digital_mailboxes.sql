-- Digital mailboxes (Kivra, Billo): one row per company and provider, for
-- both directions, and the log of invoices sent to a recipient's mailbox.
-- pg-test: tests/pg/digital-mailboxes.pg.test.ts,
--          tests/pg/sandbox-teardown-coverage.pg.test.ts,
--          tests/pg/account-erasure.pg.test.ts
--
-- Receiving: the company's own Kivra or Billo business mailbox is read into
-- the Inkorg. Kivra identifies the company by its company_key once the
-- company has activated Accounted as its partner in Kivra; Billo by the
-- partner customer (account_ref) and the enrolment of the company's mailbox
-- (mailbox_ref). What a mailbox delivered is recorded as arrivals (source
-- 'kivra' or 'billo', source_ref = the provider's document id), which is
-- also what keeps a document from being filed twice.
--
-- Sending: the company as a sender (the provider's "tenant"), so its
-- invoices and payslips can go to a recipient's digital mailbox.
--
-- Credentials are Accounted's own partner credentials, read from the
-- environment; nothing secret is stored here. Writes go through the service
-- role from admin-only routes, the sync cron and the provider webhooks;
-- members read their company's rows through RLS.

-- =============================================================================
-- 1. digital_mailbox_connections
-- =============================================================================

CREATE TABLE public.digital_mailbox_connections (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('kivra', 'billo')),

  -- Receiving. 'pending': the company started connecting and the provider
  -- has not confirmed yet (Kivra: the activation at Kivra).
  receive_state text NOT NULL DEFAULT 'off'
    CHECK (receive_state IN ('off', 'pending', 'active', 'ended')),
  -- Kivra: company_key. Billo: partnerCustomerId.
  account_ref text CHECK (account_ref IS NULL OR length(btrim(account_ref)) BETWEEN 1 AND 128),
  -- Billo: enrollmentId. Unused for Kivra.
  mailbox_ref text CHECK (mailbox_ref IS NULL OR length(btrim(mailbox_ref)) BETWEEN 1 AND 128),
  -- Documents the mailbox received from this moment on are fetched.
  receive_since timestamptz,
  receive_connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  receive_connected_at timestamptz,
  receive_ended_at timestamptz,
  last_synced_at timestamptz,

  -- Sending: the company's sender identity at the provider.
  send_state text NOT NULL DEFAULT 'off'
    CHECK (send_state IN ('off', 'active', 'ended')),
  tenant_ref text CHECK (tenant_ref IS NULL OR length(btrim(tenant_ref)) BETWEEN 1 AND 128),
  send_activated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  send_activated_at timestamptz,

  -- Health, for the person and the operator.
  last_error text CHECK (last_error IS NULL OR length(last_error) <= 500),
  last_error_at timestamptz,
  -- What the provider answered that is worth keeping (Billo's enrolment
  -- status, the mailbox's postal address). Never a credential.
  provider_meta jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(provider_meta) = 'object'),

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT digital_mailbox_connections_company_provider_key UNIQUE (company_id, provider),
  CONSTRAINT digital_mailbox_connections_active_receive_has_account
    CHECK (receive_state <> 'active' OR account_ref IS NOT NULL),
  CONSTRAINT digital_mailbox_connections_billo_receive_has_mailbox
    CHECK (provider <> 'billo' OR receive_state <> 'active' OR mailbox_ref IS NOT NULL),
  CONSTRAINT digital_mailbox_connections_active_send_has_tenant
    CHECK (send_state <> 'active' OR tenant_ref IS NOT NULL)
);

COMMENT ON TABLE public.digital_mailbox_connections IS
  'One row per company and digital mailbox provider (Kivra, Billo): the company''s own mailbox read into the Inkorg, and the company as a sender to recipients'' mailboxes.';
COMMENT ON COLUMN public.digital_mailbox_connections.account_ref IS
  'Kivra: the company_key. Billo: the partnerCustomerId.';
COMMENT ON COLUMN public.digital_mailbox_connections.mailbox_ref IS
  'Billo: the enrollmentId of the company''s mailbox. Unused for Kivra.';
COMMENT ON COLUMN public.digital_mailbox_connections.tenant_ref IS
  'The company''s sender (tenant) key at the provider.';

-- One company reads a provider account at a time: two companies reading the
-- same mailbox would file every document twice.
CREATE UNIQUE INDEX digital_mailbox_connections_one_reader
  ON public.digital_mailbox_connections (provider, account_ref, (coalesce(mailbox_ref, '')))
  WHERE receive_state IN ('pending', 'active') AND account_ref IS NOT NULL;
-- The sync cron reads the active and pending rows.
CREATE INDEX digital_mailbox_connections_receiving
  ON public.digital_mailbox_connections (provider, receive_state)
  WHERE receive_state IN ('pending', 'active');

ALTER TABLE public.digital_mailbox_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "digital_mailbox_connections_select" ON public.digital_mailbox_connections
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.digital_mailbox_connections TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.digital_mailbox_connections TO service_role;
-- no-grant: anon on public.digital_mailbox_connections (company data)

CREATE TRIGGER digital_mailbox_connections_updated_at
  BEFORE UPDATE ON public.digital_mailbox_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- =============================================================================
-- 2. digital_mailbox_dispatches
-- =============================================================================

-- One row per attempt to send an invoice to a recipient's digital mailbox:
-- the company's record of how the invoice reached its customer. Payslips are
-- logged where every payslip delivery is, salary_payslip_deliveries.
CREATE TABLE public.digital_mailbox_dispatches (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('kivra', 'billo')),
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE CASCADE,
  recipient_kind text NOT NULL CHECK (recipient_kind IN ('company', 'person')),
  status text NOT NULL CHECK (status IN ('sent', 'failed')),
  -- The provider's id for the delivered content, when it answered one.
  provider_ref text CHECK (provider_ref IS NULL OR length(provider_ref) <= 256),
  error_code text CHECK (error_code IS NULL OR length(error_code) <= 100),
  error_message text CHECK (error_message IS NULL OR length(error_message) <= 500),
  sent_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT digital_mailbox_dispatches_failure_shape
    CHECK ((status = 'failed') = (error_code IS NOT NULL))
);

COMMENT ON TABLE public.digital_mailbox_dispatches IS
  'Each attempt to send an invoice to the recipient''s Kivra or Billo mailbox, sent or failed.';

CREATE INDEX digital_mailbox_dispatches_invoice
  ON public.digital_mailbox_dispatches (invoice_id, created_at DESC);
CREATE INDEX digital_mailbox_dispatches_company
  ON public.digital_mailbox_dispatches (company_id, created_at DESC);

ALTER TABLE public.digital_mailbox_dispatches ENABLE ROW LEVEL SECURITY;

CREATE POLICY "digital_mailbox_dispatches_select" ON public.digital_mailbox_dispatches
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.digital_mailbox_dispatches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.digital_mailbox_dispatches TO service_role;
-- no-grant: anon on public.digital_mailbox_dispatches (company data)

NOTIFY pgrst, 'reload schema';
