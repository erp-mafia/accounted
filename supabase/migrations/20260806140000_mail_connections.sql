-- Migration: mail_connections
--
-- Read-only mailbox grants used to hunt receipts for unbooked purchases.
--
-- Why a dedicated table rather than extension_data (which is how cloud-backup
-- stores its Google tokens): a company has MANY mailboxes, not one. Real books
-- mix the founder's personal Gmail, info@, ekonomi@, and an employee with a
-- company card, and each is connected by its own owner, so the row needs its
-- own identity, its own scope and its own health. extension_data is keyed
-- (company_id, extension_id, key) and would force all of that into one blob.
--
-- Why service-role only, with RLS enabled and ZERO policies: the row holds a
-- live refresh token for someone's mailbox. RLS cannot hide a column, so any
-- member-readable policy would expose the token to the browser through
-- PostgREST. The extension's API routes select the safe columns explicitly and
-- return those. Same posture as whatsapp_messages (20260802091000).
--
-- Uniqueness is (company_id, provider, email_address), NOT (company_id,
-- provider): connecting a second Gmail account must be additive. Reconnecting
-- the SAME address updates the existing row so a re-grant cannot silently
-- create a duplicate that both get swept.
--
-- Existing rows: none, this is a new capability.

CREATE TABLE IF NOT EXISTS public.mail_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gmail', 'microsoft')),
  -- The mailbox itself, shown to the user so they can tell two grants apart.
  email_address text NOT NULL,
  -- Whoever consented. Kept for provenance and for the GDPR story: a grant is
  -- given by the mailbox's owner, never by an admin on their behalf.
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  -- AES-256-GCM, encrypted in the application. Never selected by any route
  -- that answers a browser.
  encrypted_refresh_token text NOT NULL,
  encrypted_access_token text,
  access_token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  -- Optional narrowing, e.g. a single Gmail label. NULL means the whole
  -- mailbox is searchable.
  scope_label text,
  -- How far back a newly connected mailbox may be searched once.
  backfill_from date,
  backfill_completed_at timestamptz,
  -- Health, so a dead grant stops being retried every night and surfaces one
  -- reconnect action instead of failing opaquely mid-hunt (the Skatteverket
  -- needs_reconsent pattern, 20260324120001).
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_reconsent', 'revoked')),
  last_error_code text,
  last_error_at timestamptz,
  last_searched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Plain columns, not lower(email_address): an upsert's ON CONFLICT target must
-- match the index expression exactly, and an expression index would make every
-- reconnect raise 42P10. The address is lowercased by the application before it
-- is written, so case-insensitive dedupe is preserved without the expression.
CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_connections_identity
  ON public.mail_connections (company_id, provider, email_address);

-- The hunt's read path: healthy connections for one company.
CREATE INDEX IF NOT EXISTS idx_mail_connections_company_active
  ON public.mail_connections (company_id)
  WHERE status = 'active';

ALTER TABLE public.mail_connections ENABLE ROW LEVEL SECURITY;
-- Deliberately no policies: service role only. See the header.

DROP TRIGGER IF EXISTS mail_connections_updated_at ON public.mail_connections;
CREATE TRIGGER mail_connections_updated_at
  BEFORE UPDATE ON public.mail_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.mail_connections IS
  'Read-only mailbox grants for receipt hunting. Service-role only: rows carry live refresh tokens.';

NOTIFY pgrst, 'reload schema';
