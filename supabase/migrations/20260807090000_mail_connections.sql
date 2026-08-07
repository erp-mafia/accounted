CREATE TABLE IF NOT EXISTS public.mail_connections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gmail', 'microsoft')),
  email_address text NOT NULL,
  connected_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  encrypted_refresh_token text NOT NULL,
  encrypted_access_token text,
  access_token_expires_at timestamptz,
  scopes text[] NOT NULL DEFAULT '{}',
  scope_label text,
  backfill_from date,
  backfill_completed_at timestamptz,
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'needs_reconsent', 'revoked')),
  last_error_code text,
  last_error_at timestamptz,
  last_searched_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_connections_identity
  ON public.mail_connections (company_id, provider, email_address);

CREATE INDEX IF NOT EXISTS idx_mail_connections_company_active
  ON public.mail_connections (company_id)
  WHERE status = 'active';

ALTER TABLE public.mail_connections ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS mail_connections_updated_at ON public.mail_connections;
CREATE TRIGGER mail_connections_updated_at
  BEFORE UPDATE ON public.mail_connections
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

COMMENT ON TABLE public.mail_connections IS
  'Read-only mailbox grants for receipt hunting. Service-role only: rows carry live refresh tokens.';

NOTIFY pgrst, 'reload schema';
