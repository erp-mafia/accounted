-- The signatory link: a company admin (or the byrå member acting for the
-- company) sends the firmatecknare a signed, expiring link. The firmatecknare
-- opens /koppla/<token> without an Accounted login and runs the bank consent
-- for that company through Open Payments (BankID), and optionally the
-- payments verification form.
--
-- The clear token lives only in the URL: 32 random bytes, sha256-hashed at
-- rest, the same posture as salary_payslip_links. A link is valid 7 days and
-- is consumed when the accounts are selected (connection_id then names the
-- connection it made). The public routes read the row with the service role;
-- owners and admins of the company create and read their company's rows.
--
-- pg-test: covered-by tests/pg/bank-connect-invites.pg.test.ts

CREATE TABLE public.bank_connect_invites (
  id                    uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Who asked. The company keeps it as the record of who sent the link; the
  -- public routes act as this person (bank_connections.user_id) for the consent.
  created_by            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash            text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  -- The bank the link is for; NULL lets the firmatecknare pick one.
  bic                   text CHECK (bic IS NULL OR bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$'),
  -- The connection the new one takes over from (a switch from Enable Banking, or a renewal).
  replace_connection_id uuid REFERENCES public.bank_connections(id) ON DELETE SET NULL,
  offer_payments        boolean NOT NULL DEFAULT false,
  recipient_email       text,
  mail_sent_at          timestamptz,
  expires_at            timestamptz NOT NULL,
  consumed_at           timestamptz,
  connection_id         uuid REFERENCES public.bank_connections(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.bank_connect_invites IS
  'Signatory links for a bank consent through Open Payments: the firmatecknare opens /koppla/<token> without a login. Token hashed at rest, 7 days, consumed on account selection.';
COMMENT ON COLUMN public.bank_connect_invites.token_hash IS
  'sha256 of the clear token, which exists only in the URL (and the mail that carried it).';
COMMENT ON COLUMN public.bank_connect_invites.mail_sent_at IS
  'When the link was mailed to recipient_email; NULL when the link was only shown to the sender.';

CREATE INDEX bank_connect_invites_company ON public.bank_connect_invites (company_id, created_at DESC);

ALTER TABLE public.bank_connect_invites ENABLE ROW LEVEL SECURITY;

-- Owners and admins of the company create and read its links. Nobody edits a
-- link from a browser session: consumption and the mail log are written by
-- the service role.
CREATE POLICY "bank_connect_invites_select_admin" ON public.bank_connect_invites
  FOR SELECT USING (public.user_is_company_admin(company_id));

CREATE POLICY "bank_connect_invites_insert_admin" ON public.bank_connect_invites
  FOR INSERT WITH CHECK (public.user_is_company_admin(company_id) AND created_by = auth.uid());

GRANT SELECT, INSERT ON TABLE public.bank_connect_invites TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_connect_invites TO service_role;
-- no-grant: anon on public.bank_connect_invites (the public routes run as the service role; the token is the credential)

NOTIFY pgrst, 'reload schema';
