-- The payment signing link ("Be någon annan signera"): the person who
-- prepared and approved bank payments (a byrå member, an admin, or an agent's
-- approved request) sends the company's firmatecknare an expiring link. The
-- firmatecknare opens /betala/<token> without an Accounted login, sees the
-- basket (payee, amount, date and reference per payment, the account paying,
-- who asked) and signs it with BankID. The same posture as the signatory link
-- for a bank consent (bank_connect_invites, /koppla/<token>).
--
-- The clear token lives only in the URL: 32 random bytes, sha256-hashed at
-- rest. A link covers exactly the payment orders it names, all approved, from
-- one account and in one currency when it was made; if any of them leaves
-- 'approved' by another way (cancelled, signed elsewhere) the page says so and
-- signs nothing. A link is valid 72 hours, consumed when the signing
-- finalises, and can be cancelled by the company before that. batch_id names
-- the signing the link started at the bank, so a reopened link resumes it.
--
-- Members read their company's links (the Betalningar page shows which orders
-- wait for someone's signature); every write is the server's, as the service
-- role, after a route authenticated the sender or resolved the token. The
-- browser session never reads token_hash (a column grant).
--
-- pg-test: covered-by tests/pg/payment-signing-links.pg.test.ts

CREATE TABLE public.payment_signing_links (
  id               uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Who asked. The company keeps it as the record of who sent the link; the
  -- token routes sign as this person (payment_order_batches.signer_user_id),
  -- with the firmatecknare's typed personnummer, never this person's own.
  created_by       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token_hash       text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  recipient_email  text CHECK (recipient_email IS NULL OR char_length(recipient_email) <= 254),
  -- The sender's message to the signer, shown on the page and in the mail.
  note             text CHECK (note IS NULL OR char_length(note) <= 500),
  order_ids        uuid[] NOT NULL CHECK (cardinality(order_ids) BETWEEN 1 AND 100 AND array_position(order_ids, NULL) IS NULL),
  total_amount     numeric(14,2) NOT NULL CHECK (total_amount > 0),
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  expires_at       timestamptz NOT NULL DEFAULT (now() + interval '72 hours'),
  mail_sent_at     timestamptz,
  batch_id         uuid REFERENCES public.payment_order_batches(id) ON DELETE SET NULL,
  consumed_at      timestamptz,
  cancelled_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at),
  CHECK (consumed_at IS NULL OR cancelled_at IS NULL)
);

COMMENT ON TABLE public.payment_signing_links IS
  'Signing links for prepared bank payments: the firmatecknare opens /betala/<token> without a login and signs the basket with BankID. Token hashed at rest, 72 hours, consumed when the signing finalises. Written by the server only.';
COMMENT ON COLUMN public.payment_signing_links.token_hash IS
  'sha256 of the clear token, which exists only in the URL (and the mail that carried it). Service-role read only.';
COMMENT ON COLUMN public.payment_signing_links.order_ids IS
  'The payment orders the link covers, all approved, from one account and in one currency when the link was made.';
COMMENT ON COLUMN public.payment_signing_links.batch_id IS
  'The signing (payment_order_batches) the link started at the bank; a reopened link resumes it.';
COMMENT ON COLUMN public.payment_signing_links.mail_sent_at IS
  'When the link was mailed to recipient_email; NULL when the link was only shown to the sender.';

CREATE INDEX payment_signing_links_company ON public.payment_signing_links (company_id, created_at DESC);
CREATE INDEX payment_signing_links_open ON public.payment_signing_links (company_id)
  WHERE consumed_at IS NULL AND cancelled_at IS NULL;

ALTER TABLE public.payment_signing_links ENABLE ROW LEVEL SECURITY;

-- Members read their company's links; nobody writes one from a browser
-- session: creation, the mail log, the signing, consumption and cancellation
-- are written by the service role after the route's own checks.
CREATE POLICY "payment_signing_links_select_member" ON public.payment_signing_links
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT (id, company_id, created_by, recipient_email, note, order_ids, total_amount, currency, expires_at, mail_sent_at, batch_id, consumed_at, cancelled_at, created_at)
  ON TABLE public.payment_signing_links TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.payment_signing_links TO service_role;
-- no-grant: anon on public.payment_signing_links (the token routes run as the service role; the token is the credential)

NOTIFY pgrst, 'reload schema';
