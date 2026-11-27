-- Spend: a company's connections to company card and spend platforms and the
-- expenses they deliver: approved and coded at the provider, each with its
-- receipt files, waiting here for a person to book them.
--
-- The provider integration lives in Accounted Connect (the `spend` family of
-- packages/connect-contract): this ledger holds the connection and the
-- expenses, Connect holds the integrator credential and the company's grant
-- at the provider. Nothing here names a provider; `provider` is the slug
-- Connect returned.
--
-- 1. spend_connections: one row per connected provider company. While a
--    person is on the provider's consent page the row is 'connecting' and
--    holds the hash of the installation's OAuth state; Connect's handle
--    arrives with `complete`. The handle and the state hash are withheld
--    from members (column grants): only the server presents them. Members
--    read; every write goes through the service role after the route
--    authorised the user, so no member write policy exists and no
--    writer-role gate is needed. Disconnecting ends the row (status
--    'disconnected', ended_at) and keeps it: the expenses point at it.
-- 2. spend_items: one row per (company, provider, the provider's expense
--    id), holding Connect's model of the expense and the provider's answer
--    verbatim (BFL 7 kap archive). A booked expense is frozen: its model,
--    its archived answer and its voucher link never change again (trigger
--    below). An export that sends a booked expense again only raises
--    changed_after_booking when the answer differs; a correction is a
--    storno or rättelse by a person, never a re-book.
--
-- pg-test: tests/pg/spend-expenses.pg.test.ts

BEGIN;

CREATE TABLE public.spend_connections (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Connect's provider slug and the name it gave, kept for when Connect is down.
  provider              text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  provider_name         text NOT NULL CHECK (length(btrim(provider_name)) BETWEEN 1 AND 80),
  -- Provider code lives only in Connect: there is no direct route.
  route                 text NOT NULL DEFAULT 'connect' CHECK (route = 'connect'),
  mode                  text NOT NULL CHECK (mode IN ('oauth', 'api_key')),
  connection_handle     text CHECK (connection_handle IS NULL OR length(connection_handle) BETWEEN 16 AND 256),
  -- sha256 of the OAuth state while the person is at the provider.
  pending_state_sha256  text CHECK (pending_state_sha256 IS NULL OR pending_state_sha256 ~ '^[0-9a-f]{64}$'),
  pending_expires_at    timestamptz,
  -- Where the person started connecting (the canonical app or a brand
  -- domain), re-validated before the return redirect uses it.
  pending_return_origin text CHECK (pending_return_origin IS NULL OR pending_return_origin ~ '^https?://[^/?#]+$'),
  -- The provider's company, as Connect reported it at connect.
  provider_company_ref  text CHECK (provider_company_ref IS NULL OR length(btrim(provider_company_ref)) BETWEEN 1 AND 128),
  provider_company_name text CHECK (provider_company_name IS NULL OR length(btrim(provider_company_name)) BETWEEN 1 AND 200),
  provider_org_number   text CHECK (provider_org_number IS NULL OR provider_org_number ~ '^\d{6,20}$'),
  status                text NOT NULL DEFAULT 'connecting'
                          CHECK (status IN ('connecting', 'active', 'disconnected')),
  health                text NOT NULL DEFAULT 'ok'
                          CHECK (health IN ('ok', 'degraded', 'action_required')),
  -- The error code behind a degraded or action_required health.
  health_code           text,
  next_run_at           timestamptz NOT NULL DEFAULT now(),
  -- Run claim: the run that holds the connection sets it; the cron and a
  -- person's "Hämta nu" never pull or acknowledge the same expenses at once.
  lease_until           timestamptz NOT NULL DEFAULT 'epoch',
  last_success_at       timestamptz,
  last_error_code       text,
  last_error_at         timestamptz,
  failures_in_row       integer NOT NULL DEFAULT 0 CHECK (failures_in_row >= 0),
  -- The coding vocabulary last sent to Connect (accounts, VAT codes, dimensions).
  master_data_sha256    text CHECK (master_data_sha256 IS NULL OR master_data_sha256 ~ '^[0-9a-f]{64}$'),
  master_data_sent_at   timestamptz,
  -- Wallet and utlägg accounts (lib/spend/settings.ts).
  settings              jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(settings) = 'object'),
  created_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  ended_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ended_at              timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_connections_ended_iff_disconnected
    CHECK ((status = 'disconnected') = (ended_at IS NOT NULL)),
  CONSTRAINT spend_connections_active_has_handle
    CHECK (status <> 'active' OR connection_handle IS NOT NULL),
  CONSTRAINT spend_connections_connecting_has_state
    CHECK (status <> 'connecting' OR (pending_state_sha256 IS NOT NULL AND pending_expires_at IS NOT NULL))
);

COMMENT ON TABLE public.spend_connections IS
  'Company card and spend platforms a company has connected through Accounted Connect (spend family). Ended, never deleted: the expenses point here.';

CREATE UNIQUE INDEX spend_connections_one_live_per_provider
  ON public.spend_connections (company_id, provider)
  WHERE status <> 'disconnected';

CREATE UNIQUE INDEX spend_connections_pending_state
  ON public.spend_connections (pending_state_sha256)
  WHERE pending_state_sha256 IS NOT NULL;

CREATE INDEX spend_connections_due
  ON public.spend_connections (next_run_at)
  WHERE status = 'active';

CREATE INDEX spend_connections_company
  ON public.spend_connections (company_id);

CREATE TRIGGER set_updated_at_spend_connections
  BEFORE UPDATE ON public.spend_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.spend_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read spend_connections"
  ON public.spend_connections FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

REVOKE ALL ON TABLE public.spend_connections FROM PUBLIC, anon, authenticated;
GRANT SELECT (
  id, company_id, provider, provider_name, route, mode,
  provider_company_ref, provider_company_name, provider_org_number,
  status, health, health_code, next_run_at, lease_until,
  last_success_at, last_error_code, last_error_at, failures_in_row,
  master_data_sha256, master_data_sent_at, settings,
  created_by, created_at, ended_by, ended_at, updated_at
) ON public.spend_connections TO authenticated;
GRANT ALL ON TABLE public.spend_connections TO service_role;

CREATE TABLE public.spend_items (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id             uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  connection_id          uuid NOT NULL REFERENCES public.spend_connections(id) ON DELETE CASCADE,
  provider               text NOT NULL CHECK (provider ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  -- The provider's own id for the expense; an expense exported again carries it again.
  external_id            text NOT NULL CHECK (length(btrim(external_id)) BETWEEN 1 AND 128),
  batch_ref              text CHECK (batch_ref IS NULL OR length(batch_ref) <= 128),
  kind                   text NOT NULL CHECK (kind IN (
                           'card_purchase', 'card_invoice', 'fee', 'refund', 'chargeback', 'cashback',
                           'out_of_pocket', 'mileage', 'per_diem', 'reimbursement', 'external_reimbursement',
                           'wallet_topup', 'wallet_unload', 'atm_withdrawal', 'personal_spend',
                           'invoice', 'invoice_payment', 'balance_adjustment', 'other')),
  expense_date           date NOT NULL,
  currency               text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  -- Signed from the company's side: positive is money out of the wallet or
  -- owed to the person, negative money back.
  amount                 numeric(14, 2) NOT NULL,
  merchant_name          text,
  person_name            text,
  -- ready: can be booked as is; review: a person must look first (reasons);
  -- rejected: sent back to the provider with the reason; no_entry: nothing
  -- to book here (a transfer the bank row books); booked: journal_entry_id set.
  status                 text NOT NULL CHECK (status IN ('ready', 'review', 'rejected', 'no_entry', 'booked')),
  reasons                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(reasons) = 'array'),
  -- Connect's model of the expense (spendExpenseSchema without raw), verbatim.
  expense                jsonb NOT NULL CHECK (jsonb_typeof(expense) = 'object'),
  -- The provider's answer, verbatim, and its hash.
  raw_body               text NOT NULL,
  raw_content_type       text NOT NULL,
  raw_sha256             text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  -- The receipt files, stored as documents when the expense arrived.
  document_ids           uuid[] NOT NULL DEFAULT '{}',
  received_at            timestamptz NOT NULL,
  receive_count          integer NOT NULL DEFAULT 1 CHECK (receive_count >= 1),
  -- What the provider was told, and when.
  ack_outcome            text CHECK (ack_outcome IS NULL OR ack_outcome IN ('received', 'rejected')),
  acknowledged_at        timestamptz,
  -- Set when the provider sent a booked expense again with another answer.
  changed_after_booking  boolean NOT NULL DEFAULT false,
  latest_raw_sha256      text CHECK (latest_raw_sha256 IS NULL OR latest_raw_sha256 ~ '^[0-9a-f]{64}$'),
  latest_received_at     timestamptz,
  journal_entry_id       uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  booked_at              timestamptz,
  booked_by              uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT spend_items_one_per_provider_expense UNIQUE (company_id, provider, external_id),
  -- Booking claims the row (journal_entry_id set) before the commit and marks
  -- it booked after; a booked row always says when.
  CONSTRAINT spend_items_booked_has_time
    CHECK (status <> 'booked' OR booked_at IS NOT NULL)
);

COMMENT ON TABLE public.spend_items IS
  'One expense from a connected company card or spend platform: the expense model, the provider answer verbatim (BFL 7 kap), its receipt documents, and the verifikat once booked.';

CREATE INDEX spend_items_company_date
  ON public.spend_items (company_id, expense_date DESC);

CREATE INDEX spend_items_company_status
  ON public.spend_items (company_id, status);

CREATE INDEX spend_items_connection
  ON public.spend_items (connection_id);

CREATE INDEX spend_items_journal_entry
  ON public.spend_items (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

CREATE TRIGGER set_updated_at_spend_items
  BEFORE UPDATE ON public.spend_items
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

-- A booked expense is the basis of a posted verifikat: what it was booked
-- from (the model, the archived provider answer, the amount, the date, the
-- receipts) and the link to the verifikat stay as they were. Status and
-- review fields may still move, and the link may be cleared only when the
-- verifikat itself is gone (ON DELETE SET NULL) or was cancelled as a draft.
CREATE OR REPLACE FUNCTION public.spend_items_freeze_booked()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
  IF OLD.journal_entry_id IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW.expense IS DISTINCT FROM OLD.expense
     OR NEW.raw_body IS DISTINCT FROM OLD.raw_body
     OR NEW.raw_sha256 IS DISTINCT FROM OLD.raw_sha256
     OR NEW.amount IS DISTINCT FROM OLD.amount
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.expense_date IS DISTINCT FROM OLD.expense_date
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.document_ids IS DISTINCT FROM OLD.document_ids
     OR NEW.external_id IS DISTINCT FROM OLD.external_id
     OR NEW.provider IS DISTINCT FROM OLD.provider
     OR NEW.connection_id IS DISTINCT FROM OLD.connection_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'spend_items % is booked: its expense and archived answer cannot change', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id AND NEW.journal_entry_id IS NOT NULL THEN
    RAISE EXCEPTION 'spend_items % is already linked to a verifikat', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.journal_entry_id IS NULL AND EXISTS (
    SELECT 1 FROM public.journal_entries je
    WHERE je.id = OLD.journal_entry_id AND je.status IN ('posted', 'reversed')
  ) THEN
    RAISE EXCEPTION 'spend_items % points at a posted verifikat: correct it with storno, never by unlinking', OLD.id
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER spend_items_freeze_booked
  BEFORE UPDATE ON public.spend_items
  FOR EACH ROW EXECUTE FUNCTION public.spend_items_freeze_booked();

ALTER TABLE public.spend_items ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read spend_items"
  ON public.spend_items FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

REVOKE ALL ON TABLE public.spend_items FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.spend_items TO authenticated;
GRANT ALL ON TABLE public.spend_items TO service_role;

REVOKE ALL ON FUNCTION public.spend_items_freeze_booked() FROM PUBLIC, anon, authenticated;

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER spend_connections_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.spend_connections
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER spend_items_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.spend_items
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

COMMIT;

NOTIFY pgrst, 'reload schema';
