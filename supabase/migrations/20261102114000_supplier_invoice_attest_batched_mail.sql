-- Batched attest mail (crm#1569).
--
-- Until now every registered supplier invoice that needed attest mailed each
-- attester on its own, with a link for that one invoice. A byrå that
-- registers ten invoices for a client sent the client ten mails. From here
-- a registration only queues the invoice; a scheduled job sends each
-- attester ONE mail per company and round, listing every invoice waiting on
-- them, with one link to a page where they approve them all or reject one.
-- A daily job reminds the attester before the due date and tells whoever
-- registered the invoice when it passes its due date without attest, or
-- when nobody can attest it under the current rules.
--
-- 1. supplier_invoice_attest_batches: the link in such a mail. A credential
--    like supplier_invoice_attest_links (20261014220000): the token is
--    hashed at rest, valid 7 days, bound to one attester and to the invoices
--    the mail listed, usable until every one of them is answered. One row
--    per mail, stored (and leased) before the mail goes. A mail that
--    certainly did not go is tried again on the same row: one conditional
--    update gives it a fresh token and a new lease, so two links for one mail
--    never exist. At most 6 attempts, within a day.
-- 2. supplier_invoice_attest_mail_state: one row per invoice that entered
--    the batched mail flow, recording what has been sent about it, so each
--    step goes out once.
--
-- Both are service-role only: the token routes and the jobs run as the
-- service role, and no session ever reads them.

-- 1. The batched link -----------------------------------------------------------
CREATE TABLE public.supplier_invoice_attest_batches (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id        uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The attester the link speaks for: a decision through it is recorded as theirs.
  attester_user_id  uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('request', 'reminder')),
  -- The invoices the mail listed: the link decides on these and nothing else.
  invoice_ids       uuid[] NOT NULL CHECK (cardinality(invoice_ids) BETWEEN 1 AND 200 AND array_position(invoice_ids, NULL) IS NULL),
  token_hash        text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at        timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  -- Set when the mail went out, or may have (the provider's answer was lost): never sent twice.
  mail_sent_at      timestamptz,
  consumed_at       timestamptz,
  -- Tries at sending the mail; each try has its own token.
  send_attempts     smallint NOT NULL DEFAULT 1 CHECK (send_attempts BETWEEN 1 AND 6),
  -- A run is sending the mail until then; a lapsed lease is free to take.
  -- '-infinity' when no run holds it, so "free" is one comparison: send_lease_until < now().
  send_lease_until  timestamptz NOT NULL DEFAULT '-infinity',
  created_at        timestamptz NOT NULL DEFAULT now(),
  CHECK (expires_at > created_at)
);

COMMENT ON TABLE public.supplier_invoice_attest_batches IS
  'The link in the batched attest mail: one per mail to an attester, listing the invoices waiting on them in one company. Valid 7 days, used until every listed invoice is answered. Token hashed at rest. Service role only.';
COMMENT ON COLUMN public.supplier_invoice_attest_batches.token_hash IS
  'sha256 of the clear token, which exists only in the URL (and the mail that carried it).';
COMMENT ON COLUMN public.supplier_invoice_attest_batches.kind IS
  'request: the first mail after the invoices were registered. reminder: the mail before the due date.';

CREATE INDEX supplier_invoice_attest_batches_company ON public.supplier_invoice_attest_batches (company_id, created_at DESC);
-- The request job tries again what did not go: links stored but never mailed.
CREATE INDEX supplier_invoice_attest_batches_unsent ON public.supplier_invoice_attest_batches (created_at) WHERE mail_sent_at IS NULL AND consumed_at IS NULL;

ALTER TABLE public.supplier_invoice_attest_batches ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_invoice_attest_batches TO service_role;
-- no-grant: authenticated on public.supplier_invoice_attest_batches (token credentials: the token routes run as the service role)
-- no-grant: anon on public.supplier_invoice_attest_batches (token credentials: the token routes run as the service role)

-- 2. What has been sent about an invoice ----------------------------------------
CREATE TABLE public.supplier_invoice_attest_mail_state (
  supplier_invoice_id  uuid PRIMARY KEY REFERENCES public.supplier_invoices(id) ON DELETE CASCADE,
  company_id           uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- Registered and waiting for the batched request.
  queued_at            timestamptz NOT NULL DEFAULT now(),
  -- The batched request went out (or there was nobody to ask).
  asked_at             timestamptz,
  -- The reminder 3 days before the due date, and the one the day before.
  reminded_early_at    timestamptz,
  reminded_last_at     timestamptz,
  -- The registrant was told the due date passed without attest.
  overdue_told_at      timestamptz,
  -- The registrant was told that nobody can attest the invoice under the rules.
  blocked_told_at      timestamptz
);

COMMENT ON TABLE public.supplier_invoice_attest_mail_state IS
  'One row per supplier invoice in the batched attest mail flow: when it was queued, asked for, reminded about and told about, so each mail goes out once. Service role only.';

-- The request job reads the queue: rows not asked for yet.
CREATE INDEX supplier_invoice_attest_mail_state_queue ON public.supplier_invoice_attest_mail_state (queued_at) WHERE asked_at IS NULL;
CREATE INDEX supplier_invoice_attest_mail_state_company ON public.supplier_invoice_attest_mail_state (company_id);

ALTER TABLE public.supplier_invoice_attest_mail_state ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.supplier_invoice_attest_mail_state TO service_role;
-- no-grant: authenticated on public.supplier_invoice_attest_mail_state (written and read by the attest mail jobs as the service role)
-- no-grant: anon on public.supplier_invoice_attest_mail_state (written and read by the attest mail jobs as the service role)

NOTIFY pgrst, 'reload schema';
