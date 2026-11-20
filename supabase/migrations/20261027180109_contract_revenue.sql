-- =============================================================================
-- Pågående arbeten under K3 kapitel 23 (successiv vinstavräkning, opt-in)
--
--   1. contract_revenue_settings: one row per company that uses it: the
--      method (successiv vinstavräkning, K3 23.17-23.27, or for a juridisk
--      person the färdigställandemetod, 23.31) and the class 3 account the
--      year's revenue adjustment is booked on.
--   2. contract_revenue_contracts: the pågående uppdrag with their figures on
--      a balansdag (uppdragsinkomst, costs so far, expected total cost,
--      invoiced so far ...), what lib/bokslut/pagaende-arbeten computes from.
--   3. The adjustment account stays outside the momsdeklaration. Upparbetad
--      intäkt is no supply (ML 2023:200 7 kap.: the VAT arises when the
--      service is supplied or paid for, and the invoices already carried it),
--      so no ruta may read it. The rutor are derived from the account: the
--      fixed BAS map (lib/vat/moms-box-mapping.ts), then the company's own
--      momskod (default_vat_treatment), momsruta (vat_box) and momssats
--      (default_vat_rate, number and name inference when unset). The account
--      is therefore pinned:
--        - it is not one the fixed map or the ruta 05 exclusions name (the
--          list below; tests/pg/contract-revenue.pg.test.ts holds it to the
--          TypeScript table);
--        - while it is the adjustment account its momskod and momsruta stay
--          empty and its momssats stays 0 (ingen moms), which no ruta reads
--          and which stops the inference; the chart_of_accounts trigger
--          refuses any change to that, from every path (the account editor,
--          an SIE import);
--        - once it carries a posted line it stays the adjustment account, so
--          an earlier year's adjustment cannot reach a re-run declaration
--          through a later momskod.
--
-- No posted entry is touched; the verifikat go through the engine.
-- =============================================================================

-- One row per company (UNIQUE company_id, the upsert's conflict target). The
-- id is the row key write_audit_log() reads, so the choice keeps its trail.
CREATE TABLE public.contract_revenue_settings (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL UNIQUE REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  method text NOT NULL DEFAULT 'successiv' CHECK (method IN ('successiv', 'fardigstallande')),
  revenue_account text NOT NULL CHECK (
    revenue_account ~ '^3[0-7][0-9]{2}$'
    AND revenue_account NOT IN (
      '3000', '3001', '3002', '3003', '3004', '3100', '3105', '3107', '3108', '3109',
      '3211', '3212', '3220', '3231', '3232', '3233', '3305', '3308',
      '3401', '3402', '3403', '3404', '3521', '3522'
    )
  ),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.contract_revenue_settings ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_revenue_settings TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.contract_revenue_settings TO authenticated;

CREATE POLICY "view own-company contract_revenue_settings"
  ON public.contract_revenue_settings FOR SELECT USING (company_id IN (SELECT user_company_ids()));
-- Members read; a writing member saves the settings. Viewers and invoicers
-- do not (caller_can_write_company, and the trigger below).
CREATE POLICY "insert own-company contract_revenue_settings"
  ON public.contract_revenue_settings FOR INSERT WITH CHECK (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company contract_revenue_settings"
  ON public.contract_revenue_settings FOR UPDATE USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id));
-- No DELETE policy: removing the row would release the pinned account.

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.contract_revenue_settings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE TRIGGER set_updated_at_contract_revenue_settings
  BEFORE UPDATE ON public.contract_revenue_settings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_contract_revenue_settings
  AFTER INSERT OR UPDATE OR DELETE ON public.contract_revenue_settings
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- The settings only name an account that is already pinned, and keep one
-- that carries a posted line.
CREATE OR REPLACE FUNCTION public.enforce_contract_revenue_account()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.chart_of_accounts c
    WHERE c.company_id = NEW.company_id
      AND c.account_number = NEW.revenue_account
      AND c.default_vat_treatment IS NULL
      AND c.vat_box IS NULL
      AND c.default_vat_rate = 0
  ) THEN
    RAISE EXCEPTION 'Konto % ska finnas i kontoplanen utan momskod och momsruta och med momssats 0 för att ta upparbetade intäkter', NEW.revenue_account
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.revenue_account IS DISTINCT FROM OLD.revenue_account AND EXISTS (
    SELECT 1
    FROM public.journal_entry_lines l
    JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = OLD.company_id
      AND e.status IN ('posted', 'reversed')
      AND l.account_number = OLD.revenue_account
  ) THEN
    RAISE EXCEPTION 'Konto % har bokförda upparbetade intäkter och förblir kontot för dem', OLD.revenue_account
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER enforce_contract_revenue_account
  BEFORE INSERT OR UPDATE OF revenue_account ON public.contract_revenue_settings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_contract_revenue_account();

-- The adjustment account keeps no momskod, no momsruta and momssats 0.
CREATE OR REPLACE FUNCTION public.keep_contract_revenue_account_outside_vat()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.default_vat_treatment IS NOT NULL OR NEW.vat_box IS NOT NULL OR NEW.default_vat_rate IS DISTINCT FROM 0)
     AND EXISTS (
       SELECT 1 FROM public.contract_revenue_settings s
       WHERE s.company_id = NEW.company_id
         AND s.revenue_account = NEW.account_number
     ) THEN
    RAISE EXCEPTION 'Konto % tar upparbetade intäkter och står utanför momsdeklarationen: momskod och momsruta ska vara tomma och momssatsen 0', NEW.account_number
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER keep_contract_revenue_account_outside_vat
  BEFORE INSERT OR UPDATE OF default_vat_treatment, vat_box, default_vat_rate, account_number ON public.chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION public.keep_contract_revenue_account_outside_vat();

CREATE TABLE public.contract_revenue_contracts (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  kind text NOT NULL DEFAULT 'fast_pris' CHECK (kind IN ('fast_pris', 'lopande_rakning')),
  -- The balansdag the figures below are stated for.
  figures_as_of date NOT NULL,
  contract_value numeric(14, 2) NOT NULL CHECK (contract_value >= 0),
  expected_total_cost numeric(14, 2) NOT NULL CHECK (expected_total_cost >= 0),
  costs_to_date numeric(14, 2) NOT NULL DEFAULT 0 CHECK (costs_to_date >= 0),
  billed_to_date numeric(14, 2) NOT NULL DEFAULT 0 CHECK (billed_to_date >= 0),
  retained_amounts numeric(14, 2) NOT NULL DEFAULT 0 CHECK (retained_amounts >= 0),
  reliable_outcome boolean NOT NULL DEFAULT true,
  grade_method text NOT NULL DEFAULT 'utgifter' CHECK (grade_method IN ('utgifter', 'undersokning', 'fysisk')),
  stated_grade numeric(7, 6) CHECK (stated_grade IS NULL OR (stated_grade >= 0 AND stated_grade <= 1)),
  reimbursable_costs numeric(14, 2) CHECK (reimbursable_costs IS NULL OR reimbursable_costs >= 0),
  value_worked numeric(14, 2) CHECK (value_worked IS NULL OR value_worked >= 0),
  substantially_complete boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (grade_method = 'utgifter' OR stated_grade IS NOT NULL)
);

ALTER TABLE public.contract_revenue_contracts ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_revenue_contracts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.contract_revenue_contracts TO authenticated;

CREATE POLICY "view own-company contract_revenue_contracts"
  ON public.contract_revenue_contracts FOR SELECT USING (company_id IN (SELECT user_company_ids()));
CREATE POLICY "insert own-company contract_revenue_contracts"
  ON public.contract_revenue_contracts FOR INSERT WITH CHECK (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );
CREATE POLICY "update own-company contract_revenue_contracts"
  ON public.contract_revenue_contracts FOR UPDATE USING (company_id IN (SELECT user_company_ids()))
  WITH CHECK (company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id));
CREATE POLICY "delete own-company contract_revenue_contracts"
  ON public.contract_revenue_contracts FOR DELETE USING (
    company_id IN (SELECT user_company_ids()) AND public.caller_can_write_company(company_id)
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.contract_revenue_contracts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE INDEX idx_contract_revenue_contracts_company_id ON public.contract_revenue_contracts (company_id);

CREATE TRIGGER set_updated_at_contract_revenue_contracts
  BEFORE UPDATE ON public.contract_revenue_contracts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_contract_revenue_contracts
  AFTER INSERT OR UPDATE OR DELETE ON public.contract_revenue_contracts
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
