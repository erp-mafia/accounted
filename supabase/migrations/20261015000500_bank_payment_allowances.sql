-- A hard monthly cap on bank payments sent through the payment initiation
-- provider (Open Payments), with a per-company override and a way to ask for
-- more. The default is 10 payments per company and Stockholm calendar
-- month, and a signing that would pass the cap is refused
-- (BANK_PAYMENTS_ALLOWANCE_EXCEEDED). Payment files (betalfil, pain.001)
-- never reach the provider and are not capped.
--
-- The count itself is not stored: it is read from payment_orders (the orders
-- that reached the provider, src/lib/payments/usage.ts), so it cannot drift.
-- Two tables hold only what the count cannot tell:
--
--   company_bank_payment_allowances  the number of payments a month a company
--     may send when it is not the default (10). An operator raises a cap by
--     inserting or updating the row as the service role. A company never
--     raises its own cap: members may read their company's row, and a
--     browser session has no INSERT, UPDATE or DELETE (no policy and no
--     grant).
--   bank_payment_allowance_requests  a person asking for more ("Begär fler
--     betalningar" under Inställningar, Bankbetalningar). The row is written
--     by POST /api/payments/allowance-requests as the service role, which
--     also mails support; members read their company's requests. handled_at
--     is set by an operator once answered.
--
-- No audit trigger: neither table is räkenskapsinformation or a booking
-- decision (the payments themselves keep their events in
-- payment_order_events), and write_audit_log needs an id column the
-- allowance row does not have. Both are platform configuration, kept out of
-- the archive (src/lib/reports/full-archive-export.ts).
--
-- granted_by and requested_by point at auth.users and are retained on
-- account erasure (the company keeps who asked and who granted; the
-- tombstone id carries no personal data), classified in
-- tests/pg/account-erasure.pg.test.ts.
--
-- pg-test: covered-by tests/pg/bank-payment-allowances.pg.test.ts
-- pg-test: covered-by tests/pg/account-erasure.pg.test.ts

CREATE TABLE public.company_bank_payment_allowances (
  company_id       uuid PRIMARY KEY REFERENCES public.companies(id) ON DELETE CASCADE,
  monthly_payments integer NOT NULL CHECK (monthly_payments >= 0),
  note             text,
  granted_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.company_bank_payment_allowances IS
  'Bank payments (payment initiation) a company may send per Stockholm calendar month when not the default 10. Raised by founders as the service role; members read their own row, never write it.';
COMMENT ON COLUMN public.company_bank_payment_allowances.monthly_payments IS
  'Payments per calendar month that may reach the provider; a signing that would pass it is refused (BANK_PAYMENTS_ALLOWANCE_EXCEEDED). 0 stops bank payments for the company.';
COMMENT ON COLUMN public.company_bank_payment_allowances.note IS
  'Why the allowance was set, for the founders (e.g. the request it answers).';
COMMENT ON COLUMN public.company_bank_payment_allowances.granted_by IS
  'The founder who set the allowance, when known.';

CREATE TRIGGER set_updated_at_company_bank_payment_allowances
  BEFORE UPDATE ON public.company_bank_payment_allowances
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.company_bank_payment_allowances ENABLE ROW LEVEL SECURITY;

CREATE POLICY company_bank_payment_allowances_select ON public.company_bank_payment_allowances
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- Read only for a browser session: a customer must never raise its own cap.
REVOKE ALL ON TABLE public.company_bank_payment_allowances FROM anon, authenticated;
GRANT SELECT ON TABLE public.company_bank_payment_allowances TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.company_bank_payment_allowances TO service_role;
-- no-grant: anon on public.company_bank_payment_allowances (company payment configuration; no public surface reads it)

CREATE TABLE public.bank_payment_allowance_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  requested_by            uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  monthly_payments_wanted integer CHECK (monthly_payments_wanted IS NULL OR monthly_payments_wanted > 0),
  message                 text CHECK (message IS NULL OR char_length(message) <= 2000),
  created_at              timestamptz NOT NULL DEFAULT now(),
  handled_at              timestamptz,
  CHECK (handled_at IS NULL OR handled_at >= created_at)
);

COMMENT ON TABLE public.bank_payment_allowance_requests IS
  'A person asking for more included bank payments a month. Written by the server (POST /api/payments/allowance-requests), which mails support; members read their own company''s requests.';
COMMENT ON COLUMN public.bank_payment_allowance_requests.monthly_payments_wanted IS
  'How many payments a month the company says it needs; NULL when not given.';
COMMENT ON COLUMN public.bank_payment_allowance_requests.handled_at IS
  'When a founder answered the request; an open request (NULL) less than 24 hours old stops a second one.';

CREATE INDEX bank_payment_allowance_requests_company
  ON public.bank_payment_allowance_requests (company_id, created_at DESC);

ALTER TABLE public.bank_payment_allowance_requests ENABLE ROW LEVEL SECURITY;

CREATE POLICY bank_payment_allowance_requests_select ON public.bank_payment_allowance_requests
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

-- Inserts go through the API route as the service role (it also mails support).
REVOKE ALL ON TABLE public.bank_payment_allowance_requests FROM anon, authenticated;
GRANT SELECT ON TABLE public.bank_payment_allowance_requests TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_payment_allowance_requests TO service_role;
-- no-grant: anon on public.bank_payment_allowance_requests (company support requests; no public surface reads them)

NOTIFY pgrst, 'reload schema';
