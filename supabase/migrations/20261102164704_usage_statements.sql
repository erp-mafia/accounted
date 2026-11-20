-- Priced usage: a company's acceptance that use above what its plan
-- includes costs money, and the month's usage statements
-- (src/lib/usage/consent.ts, src/lib/usage/close-period.ts).
--
-- The usage itself is counted from the logs that already exist (payment
-- orders, Peppol deliveries, digital mailbox dispatches, payslip deliveries,
-- signing requests): neither table is a second ledger of usage.
--
-- usage_consents: when a company reaches what a month includes, a person
-- with the admin role accepts that more costs the unit price, once per kind,
-- until someone turns it off. The row keeps who accepted, when, and the price
-- and included amount they were shown; turning it off closes the row and a
-- new acceptance opens a new one, so the history stays. Nothing above the
-- included amount is billed without an open acceptance.
--
-- usage_statements: the month's closing statement, one row per company,
-- month and kind, written by the monthly usage cron with the service role.
-- What was billed lands as a line on the company's own subscription
-- invoice (stripe_invoice_item_id); a yearly plan's lines get an invoice of
-- their own each month (stripe_invoice_id). The unique key is what keeps a
-- rerun of the cron from billing a month twice.
--
-- Amounts are whole öre, exkl. moms: unit_price_ore x billable = amount_ore,
-- never a float. Members read their own company's rows; nobody but the
-- service role writes.

CREATE TABLE public.usage_consents (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('bank_payment', 'peppol_send', 'kivra_send', 'billo_send', 'signing')),
  -- What the person was shown when accepting: the price above, and what a month includes.
  unit_price_ore integer NOT NULL CHECK (unit_price_ore > 0),
  included integer NOT NULL CHECK (included >= 0),
  accepted_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  accepted_at timestamptz NOT NULL DEFAULT now(),
  revoked_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_consents_revoked_shape CHECK (revoked_by IS NULL OR revoked_at IS NOT NULL)
);

-- One open acceptance per company and kind.
CREATE UNIQUE INDEX usage_consents_one_open ON public.usage_consents (company_id, kind) WHERE revoked_at IS NULL;

ALTER TABLE public.usage_consents ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_consents_select" ON public.usage_consents
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.usage_consents TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_consents TO service_role;
-- no-grant: anon on public.usage_consents (company billing data)

CREATE TRIGGER usage_consents_updated_at
  BEFORE UPDATE ON public.usage_consents
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TABLE public.usage_statements (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- YYYY-MM, the Stockholm calendar month.
  period text NOT NULL CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  kind text NOT NULL CHECK (kind IN ('bank_payment', 'peppol_send', 'kivra_send', 'billo_send', 'signing')),
  used integer NOT NULL CHECK (used >= 0),
  -- NULL when the kind has no included amount (not priced yet).
  included integer CHECK (included IS NULL OR included >= 0),
  billable integer NOT NULL CHECK (billable >= 0),
  unit_price_ore integer CHECK (unit_price_ore IS NULL OR unit_price_ore >= 0),
  amount_ore integer NOT NULL CHECK (amount_ore >= 0),
  status text NOT NULL CHECK (status IN ('preview', 'billing', 'billed', 'failed')),
  -- Why a statement was not billed: billing_off, no_price, nothing_billable, no_consent, not_paying.
  reason text CHECK (reason IS NULL OR length(reason) <= 64),
  stripe_invoice_item_id text CHECK (stripe_invoice_item_id IS NULL OR length(stripe_invoice_item_id) <= 255),
  -- Set when the line got an invoice of its own (a yearly plan); NULL when it rides the next subscription invoice.
  stripe_invoice_id text CHECK (stripe_invoice_id IS NULL OR length(stripe_invoice_id) <= 255),
  error text CHECK (error IS NULL OR length(error) <= 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT usage_statements_company_period_kind_key UNIQUE (company_id, period, kind),
  CONSTRAINT usage_statements_amount_shape
    CHECK (amount_ore = COALESCE(unit_price_ore, 0) * billable),
  CONSTRAINT usage_statements_billed_shape
    CHECK (status <> 'billed' OR stripe_invoice_item_id IS NOT NULL)
);

CREATE INDEX usage_statements_period ON public.usage_statements (period, status);

ALTER TABLE public.usage_statements ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_statements_select" ON public.usage_statements
  FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));

GRANT SELECT ON TABLE public.usage_statements TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.usage_statements TO service_role;
-- no-grant: anon on public.usage_statements (company billing data)

CREATE TRIGGER usage_statements_updated_at
  BEFORE UPDATE ON public.usage_statements
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

NOTIFY pgrst, 'reload schema';
