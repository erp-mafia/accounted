-- The company's verification (know your customer) at the payment provider,
-- as last read: one row per company. Payments through the bank need the
-- provider's verification; the provider is asked live, and every answer is
-- written here so the Betalningar page, the worklist and the machine doors
-- can say where the company stands without a provider call, and so the
-- renewal nudge has a date to work from.
--
-- A verification is a hosted form: creating one answers a URL that is valid
-- 24 hours; a person fills it in and a firmatecknare signs it with BankID.
-- The link columns remember the current form (when it was created, when it
-- runs out, whether it was handed to a signatory) so a person always knows
-- whether a form is open, waiting for the signatory, or expired. link_url is
-- the form itself: service-role read only (a column grant keeps it from the
-- browser session), never logged.
--
-- pg-test: covered-by tests/pg/company-payment-verifications.pg.test.ts

CREATE TABLE public.company_payment_verifications (
  company_id      uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The provider's last answer: valid (payments allowed), invalid (not
  -- verified, failed or lapsed), unknown (never asked, or no answer yet).
  status          text NOT NULL DEFAULT 'unknown' CHECK (status IN ('valid', 'invalid', 'unknown')),
  -- The date the provider reports the verification valid through.
  valid_until     date,
  -- When the provider was last asked.
  checked_at      timestamptz,
  -- The current form link, when one was created.
  link_created_at timestamptz,
  link_url        text,
  link_expires_at timestamptz,
  -- Set when the form was handed to a firmatecknare (mailed or copied for
  -- them) rather than opened by the person at the screen; NULL otherwise.
  handed_off_at   timestamptz,
  -- Who created the current form link; NULL for a record the cron refreshed.
  started_by      uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (link_expires_at IS NULL OR link_created_at IS NOT NULL),
  CHECK (link_expires_at IS NULL OR link_expires_at > link_created_at),
  CHECK (handed_off_at IS NULL OR link_created_at IS NOT NULL)
);

COMMENT ON TABLE public.company_payment_verifications IS
  'The payment provider''s verification (KYC) of the company as last read, one row per company, plus the current 24-hour form link. Written by the server only.';
COMMENT ON COLUMN public.company_payment_verifications.status IS
  'valid: payments allowed. invalid: not verified, failed or lapsed. unknown: never asked or no answer.';
COMMENT ON COLUMN public.company_payment_verifications.valid_until IS
  'The date the provider reports the verification valid through; the renewal nudge counts down to it.';
COMMENT ON COLUMN public.company_payment_verifications.link_url IS
  'The hosted verification form (valid 24 h from link_created_at). Sensitive: service-role read only, never logged.';
COMMENT ON COLUMN public.company_payment_verifications.handed_off_at IS
  'When the current form was handed to a firmatecknare instead of opened here; the state then reads awaiting_signatory until the status is valid.';

CREATE TRIGGER set_updated_at_company_payment_verifications
  BEFORE UPDATE ON public.company_payment_verifications
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.company_payment_verifications ENABLE ROW LEVEL SECURITY;

-- Members read their company's record (what the page and the worklist show);
-- every write is the server's, as the service role, after a route or a cron
-- authenticated the caller.
CREATE POLICY "view own-company company_payment_verifications"
  ON public.company_payment_verifications
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- The browser session never sees the form URL: a column grant without link_url.
GRANT SELECT (company_id, status, valid_until, checked_at, link_created_at, link_expires_at, handed_off_at, started_by, created_at, updated_at)
  ON TABLE public.company_payment_verifications TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_payment_verifications TO service_role;
-- no-grant: anon on public.company_payment_verifications (members and the server only)

NOTIFY pgrst, 'reload schema';
