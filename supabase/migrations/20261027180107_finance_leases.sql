-- =============================================================================
-- Finansiell leasing for a lessee under K3 kapitel 20 (opt-in)
--
-- A company that does not use the legal-entity relief of K3 20.29 (every
-- finansiellt leasingavtal treated as operationellt) capitalises its
-- finansiella leasingavtal (20.5-20.11). The relief stays the default.
--
--   1. company_settings.finance_lease_capitalisation: the company's choice,
--      default false (20.29).
--   2. finance_leases: the lessee's register, one row per lease: the terms
--      the schedule is computed from (lib/bokslut/leasing/finance-lease.ts)
--      and the accounts its verifikat use; initial_entry_id once the asset
--      and liability are booked at the start (20.5).
--   3. finance_lease_postings: one row per financial year whose year-end
--      adjustment (payments to interest and amortisation, accrued interest,
--      depreciation) is booked, so a year is never booked twice.
--
-- No posted entry is touched; the verifikat go through the engine.
-- =============================================================================

ALTER TABLE public.company_settings
  ADD COLUMN IF NOT EXISTS finance_lease_capitalisation boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.company_settings.finance_lease_capitalisation IS
  'When true the company capitalises finansiella leasingavtal (K3 20.5-20.11) instead of the legal-entity relief of K3 20.29.';

CREATE TABLE public.finance_leases (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  start_date date NOT NULL,
  fair_value numeric(14, 2) NOT NULL CHECK (fair_value > 0),
  payment numeric(14, 2) NOT NULL CHECK (payment > 0),
  number_of_payments integer NOT NULL CHECK (number_of_payments BETWEEN 1 AND 600),
  periods_per_year integer NOT NULL CHECK (periods_per_year IN (1, 2, 4, 12)),
  payments_in_advance boolean NOT NULL DEFAULT true,
  guaranteed_residual numeric(14, 2) NOT NULL DEFAULT 0 CHECK (guaranteed_residual >= 0),
  annual_rate_percent numeric(7, 4) NOT NULL CHECK (annual_rate_percent >= 0 AND annual_rate_percent < 100),
  direct_costs numeric(14, 2) NOT NULL DEFAULT 0 CHECK (direct_costs >= 0),
  useful_life_months integer NOT NULL CHECK (useful_life_months BETWEEN 1 AND 1200),
  ownership_transfers boolean NOT NULL DEFAULT false,
  asset_account text NOT NULL CHECK (asset_account ~ '^[0-9]{4}$'),
  accumulated_depreciation_account text NOT NULL CHECK (accumulated_depreciation_account ~ '^[0-9]{4}$'),
  liability_account text NOT NULL CHECK (liability_account ~ '^[0-9]{4}$'),
  lease_cost_account text NOT NULL CHECK (lease_cost_account ~ '^[0-9]{4}$'),
  interest_account text NOT NULL DEFAULT '8419' CHECK (interest_account ~ '^[0-9]{4}$'),
  accrued_interest_account text NOT NULL DEFAULT '2960' CHECK (accrued_interest_account ~ '^[0-9]{4}$'),
  depreciation_account text NOT NULL DEFAULT '7836' CHECK (depreciation_account ~ '^[0-9]{4}$'),
  direct_cost_account text CHECK (direct_cost_account IS NULL OR direct_cost_account ~ '^[0-9]{4}$'),
  -- SET NULL, not RESTRICT: a posted verifikat is never deleted, except by
  -- the sanctioned destructive paths (the fiscal-year reset, the sandbox
  -- teardown), and then the lease's start is simply no longer booked.
  initial_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (direct_costs = 0 OR direct_cost_account IS NOT NULL)
);

ALTER TABLE public.finance_leases ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.finance_leases TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.finance_leases TO authenticated;

CREATE POLICY "view own-company finance_leases"
  ON public.finance_leases FOR SELECT USING (company_id IN (SELECT user_company_ids()));
-- Members read; a writing member changes the register. Viewers and
-- invoicers do neither (caller_can_write_company, and the trigger below).
CREATE POLICY "insert own-company finance_leases"
  ON public.finance_leases FOR INSERT WITH CHECK (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company finance_leases"
  ON public.finance_leases FOR UPDATE USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id));
-- A lease whose start is booked is part of the books: it stays.
CREATE POLICY "delete own-company finance_leases"
  ON public.finance_leases FOR DELETE USING (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
    AND initial_entry_id IS NULL
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.finance_leases
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE INDEX idx_finance_leases_company_id ON public.finance_leases (company_id);
-- The probes a deleted journal entry runs (SET NULL here, CASCADE below).
CREATE INDEX idx_finance_leases_initial_entry_id ON public.finance_leases (initial_entry_id)
  WHERE initial_entry_id IS NOT NULL;

CREATE TRIGGER set_updated_at_finance_leases
  BEFORE UPDATE ON public.finance_leases
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_finance_leases
  AFTER INSERT OR UPDATE OR DELETE ON public.finance_leases
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

CREATE TABLE public.finance_lease_postings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  -- CASCADE for the same reason: when a destructive path removes the
  -- year-end verifikat, the year is no longer booked and can be again.
  journal_entry_id uuid REFERENCES public.journal_entries(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, fiscal_period_id)
);

ALTER TABLE public.finance_lease_postings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.finance_lease_postings TO service_role;
GRANT SELECT, INSERT ON TABLE public.finance_lease_postings TO authenticated;

CREATE POLICY "view own-company finance_lease_postings"
  ON public.finance_lease_postings FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company finance_lease_postings"
  ON public.finance_lease_postings FOR INSERT WITH CHECK (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.finance_lease_postings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE INDEX idx_finance_lease_postings_company_id ON public.finance_lease_postings (company_id);
CREATE INDEX idx_finance_lease_postings_journal_entry_id ON public.finance_lease_postings (journal_entry_id)
  WHERE journal_entry_id IS NOT NULL;

CREATE TRIGGER audit_finance_lease_postings
  AFTER INSERT OR UPDATE OR DELETE ON public.finance_lease_postings
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
