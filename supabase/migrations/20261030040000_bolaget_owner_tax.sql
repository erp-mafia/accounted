-- =============================================================================
-- Bolaget, wave 4b: owner tax and related parties
--
--   1. k10_owner_inputs: what a delägare enters for the K10 underlag of an
--      inkomstår that the company's books do not hold: the sparat
--      utdelningsutrymme brought forward, an omkostnadsbelopp of their own
--      (shares bought before the aktiebok, a gift), a löneunderlag or own
--      cash pay that differs from the payroll in Accounted (subsidiaries,
--      state-subsidised pay), and whether the grundbelopp is used in this
--      company. Keyed by party, never by personnummer. The K10 itself is
--      computed in code (lib/bolaget/owner-tax/k10-math.ts) and filed by
--      the owner.
--   2. owner_loans: loans between the company and its owners, board, VD and
--      related persons (ABL 21 kap.), and security the company gave for
--      them (21:3). Direction, BAS account, principal, outstanding, terms,
--      the låneförbud exception claimed (21:2, 21:8). The låneförbud check
--      runs in code and warns; nothing here refuses a loan. Never deleted:
--      a loan is repaid or cancelled (the 21:10 list is kept ten years).
--   3. owner_loan_interest: the interest the company paid (or received) on
--      a loan per inkomstår, and the tax withheld (KU20 fields 503 and 001).
--   4. ku20_specification_numbers: KU20 field 570 per recipient and year,
--      kept so a corrected file replaces the same kontrolluppgift.
--   5. pending_operations.operation_type: the staged writes, expanded from
--      the constraint's current definition, NOT VALID; the VALIDATE runs in
--      20261030040100.
--
-- No personnummer is stored here: KU20 reads it from party_person_private
-- (service role) when an owner or administrator downloads the file. No
-- verifikat is posted by this wave.
--
-- pg-test: tests/pg/owner-tax.pg.test.ts
-- =============================================================================

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. k10_owner_inputs
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.k10_owner_inputs (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id             uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  party_id               uuid NOT NULL,
  -- The 3:12 rules after SFS 2025:1361 apply from inkomstår 2026.
  income_year            integer NOT NULL CHECK (income_year BETWEEN 2026 AND 2099),
  -- Sparat utdelningsutrymme from the owner's K10 for the year before (not uplifted from 2026).
  saved_dividend_space   numeric(15, 2) NOT NULL DEFAULT 0 CHECK (saved_dividend_space >= 0),
  -- The owner's omkostnadsbelopp for the shares held at the start of the year, when the aktiebok and the tillskott do not tell it.
  cost_basis_override    numeric(15, 2) CHECK (cost_basis_override IS NULL OR cost_basis_override >= 0),
  -- The löneunderlag (cash pay the year before, subsidiaries included, state-subsidised pay excluded) when it differs from the payroll here.
  payroll_base_override  numeric(15, 2) CHECK (payroll_base_override IS NULL OR payroll_base_override >= 0),
  -- The owner's and närståendes own cash pay the year before (the 50 times cap), when it differs from the payroll here.
  own_pay_override       numeric(15, 2) CHECK (own_pay_override IS NULL OR own_pay_override >= 0),
  -- The grundbelopp is used for shares in one company only.
  uses_basic_amount      boolean NOT NULL DEFAULT true,
  note                   text CHECK (note IS NULL OR length(note) <= 2000),
  updated_by             uuid REFERENCES auth.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT k10_owner_inputs_one_per_year UNIQUE (company_id, party_id, income_year),
  CONSTRAINT k10_owner_inputs_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.k10_owner_inputs IS
  'What a delägare enters for the K10 underlag of an inkomstår that the books do not hold (sparat utdelningsutrymme, omkostnadsbelopp, löneunderlag overrides). Keyed by party, never by personnummer.';

CREATE INDEX IF NOT EXISTS idx_k10_owner_inputs_party ON public.k10_owner_inputs (party_id);

ALTER TABLE public.k10_owner_inputs ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.k10_owner_inputs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.k10_owner_inputs TO authenticated;
-- no-grant: anon on public.k10_owner_inputs (company data)

DROP POLICY IF EXISTS "view own-company k10_owner_inputs" ON public.k10_owner_inputs;
CREATE POLICY "view own-company k10_owner_inputs"
  ON public.k10_owner_inputs FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company k10_owner_inputs" ON public.k10_owner_inputs;
CREATE POLICY "insert own-company k10_owner_inputs"
  ON public.k10_owner_inputs FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company k10_owner_inputs" ON public.k10_owner_inputs;
CREATE POLICY "update own-company k10_owner_inputs"
  ON public.k10_owner_inputs FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.k10_owner_inputs;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.k10_owner_inputs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS k10_owner_inputs_block_migration_reset_source_mutation ON public.k10_owner_inputs;
CREATE TRIGGER k10_owner_inputs_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.k10_owner_inputs
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS set_updated_at_k10_owner_inputs ON public.k10_owner_inputs;
CREATE TRIGGER set_updated_at_k10_owner_inputs
  BEFORE UPDATE ON public.k10_owner_inputs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_k10_owner_inputs ON public.k10_owner_inputs;
CREATE TRIGGER audit_k10_owner_inputs
  AFTER INSERT OR UPDATE OR DELETE ON public.k10_owner_inputs
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 2. owner_loans
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.owner_loans (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  -- The borrower (company lends) or the lender (company borrows).
  party_id              uuid NOT NULL,
  -- loan, or security the company gave for the party's debt (ABL 21:3).
  kind                  text NOT NULL DEFAULT 'loan' CHECK (kind IN ('loan', 'security')),
  direction             text NOT NULL CHECK (direction IN ('lends', 'borrows')),
  -- What the registers cannot tell: none (holders, board and VD are read
  -- from the aktiebok and the roles), group_insider (a holder, board member
  -- or VD in another company of the group), related_person (spouse,
  -- cohabitant or relative of related_to_party_id), controlled_entity (a
  -- legal person related_to_party_id controls).
  relation              text NOT NULL DEFAULT 'none'
                        CHECK (relation IN ('none', 'group_insider', 'related_person', 'controlled_entity')),
  related_to_party_id   uuid,
  relation_detail       text CHECK (relation_detail IS NULL OR length(relation_detail) <= 200),
  -- The BAS account the loan is booked on: 1360-1368 or 1680-1689 when the
  -- company lends, 2390-2399 or 2890-2899 when it borrows. None for a security.
  account               text CHECK (account IS NULL OR account ~ '^(136[0-8]|168[0-9]|239[0-9]|289[0-9])$'),
  principal             numeric(15, 2) NOT NULL CHECK (principal > 0),
  -- What the register says is still owed (the ledger is reconciled against it).
  outstanding           numeric(15, 2) NOT NULL CHECK (outstanding >= 0),
  -- Yearly interest in percent.
  interest_rate         numeric(7, 4) CHECK (interest_rate IS NULL OR (interest_rate >= 0 AND interest_rate <= 100)),
  start_date            date NOT NULL,
  maturity_date         date,
  terms                 text CHECK (terms IS NULL OR length(terms) <= 2000),
  document_id           uuid,
  -- The låneförbud exception claimed: group_company (21:2 first para p. 1),
  -- business_loan (21:2 first para p. 2, on the 21:10 list) or
  -- dispensation (21:8, on the 21:10 list). The 1 % holding exception is
  -- read from the aktiebok, never claimed.
  exception             text NOT NULL DEFAULT 'none'
                        CHECK (exception IN ('none', 'group_company', 'business_loan', 'dispensation')),
  exception_note        text CHECK (exception_note IS NULL OR length(exception_note) <= 2000),
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'repaid', 'cancelled')),
  repaid_on             date,
  note                  text CHECK (note IS NULL OR length(note) <= 2000),
  created_by            uuid REFERENCES auth.users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_loans_id_company UNIQUE (id, company_id),
  CONSTRAINT owner_loans_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id),
  CONSTRAINT owner_loans_related_same_company
    FOREIGN KEY (related_to_party_id, company_id) REFERENCES public.parties(id, company_id),
  -- A security is something the company gives.
  CONSTRAINT owner_loans_security_lends CHECK (kind = 'loan' OR direction = 'lends'),
  CONSTRAINT owner_loans_loan_has_account CHECK (kind = 'security' OR account IS NOT NULL),
  CONSTRAINT owner_loans_account_side CHECK (account IS NULL OR ((direction = 'lends') = (account LIKE '1%'))),
  CONSTRAINT owner_loans_outstanding_le_principal CHECK (outstanding <= principal),
  CONSTRAINT owner_loans_repaid_dated CHECK ((status = 'repaid') = (repaid_on IS NOT NULL)),
  CONSTRAINT owner_loans_repaid_after_start CHECK (repaid_on IS NULL OR repaid_on >= start_date),
  CONSTRAINT owner_loans_maturity_after_start CHECK (maturity_date IS NULL OR maturity_date >= start_date),
  CONSTRAINT owner_loans_related_named
    CHECK ((relation IN ('related_person', 'controlled_entity')) = (related_to_party_id IS NOT NULL)),
  CONSTRAINT owner_loans_related_other CHECK (related_to_party_id IS NULL OR related_to_party_id <> party_id)
);

COMMENT ON TABLE public.owner_loans IS
  'Loans between the company and its owners, board, VD and related persons, and security given for them (ABL 21 kap.). The låneförbud check warns in code. Never deleted.';

CREATE INDEX IF NOT EXISTS idx_owner_loans_company ON public.owner_loans (company_id, start_date);
CREATE INDEX IF NOT EXISTS idx_owner_loans_party ON public.owner_loans (party_id);
CREATE INDEX IF NOT EXISTS idx_owner_loans_related ON public.owner_loans (related_to_party_id) WHERE related_to_party_id IS NOT NULL;

-- Who registered a loan and when never change, and a loan is never
-- deleted: it is repaid or cancelled (the 21:10 list is kept ten years). A
-- cascade (the company deleted) runs inside a trigger and passes.
CREATE OR REPLACE FUNCTION public.owner_loans_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'OWNER_LOAN_APPEND_ONLY: a loan is repaid or cancelled, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'OWNER_LOAN_APPEND_ONLY: who registered a loan and when never change'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.owner_loans_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.owner_loans ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.owner_loans TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.owner_loans TO authenticated;
-- no-grant: anon on public.owner_loans (company data)

DROP POLICY IF EXISTS "view own-company owner_loans" ON public.owner_loans;
CREATE POLICY "view own-company owner_loans"
  ON public.owner_loans FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company owner_loans" ON public.owner_loans;
CREATE POLICY "insert own-company owner_loans"
  ON public.owner_loans FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company owner_loans" ON public.owner_loans;
CREATE POLICY "update own-company owner_loans"
  ON public.owner_loans FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.owner_loans;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.owner_loans
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS owner_loans_block_migration_reset_source_mutation ON public.owner_loans;
CREATE TRIGGER owner_loans_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.owner_loans
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS owner_loans_guard ON public.owner_loans;
CREATE TRIGGER owner_loans_guard
  BEFORE UPDATE OR DELETE ON public.owner_loans
  FOR EACH ROW EXECUTE FUNCTION public.owner_loans_guard();
DROP TRIGGER IF EXISTS set_updated_at_owner_loans ON public.owner_loans;
CREATE TRIGGER set_updated_at_owner_loans
  BEFORE UPDATE ON public.owner_loans
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_owner_loans ON public.owner_loans;
CREATE TRIGGER audit_owner_loans
  AFTER INSERT OR UPDATE OR DELETE ON public.owner_loans
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 3. owner_loan_interest
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.owner_loan_interest (
  id               uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id       uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  owner_loan_id    uuid NOT NULL,
  income_year      integer NOT NULL CHECK (income_year BETWEEN 2000 AND 2099),
  -- Interest paid (company borrows) or received (company lends) in the year.
  interest_amount  numeric(15, 2) NOT NULL CHECK (interest_amount >= 0),
  -- Preliminary tax the company withheld on interest it paid (KU20 field 001).
  tax_withheld     numeric(15, 2) NOT NULL DEFAULT 0 CHECK (tax_withheld >= 0),
  note             text CHECK (note IS NULL OR length(note) <= 2000),
  updated_by       uuid REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT owner_loan_interest_one_per_year UNIQUE (owner_loan_id, income_year),
  CONSTRAINT owner_loan_interest_loan_same_company
    FOREIGN KEY (owner_loan_id, company_id) REFERENCES public.owner_loans(id, company_id) ON DELETE CASCADE,
  CONSTRAINT owner_loan_interest_tax_le_interest CHECK (tax_withheld <= interest_amount)
);

COMMENT ON TABLE public.owner_loan_interest IS
  'Interest on an owner loan per inkomstår and the tax withheld: the KU20 (fields 503 and 001) for interest the company paid to a natural person.';

CREATE INDEX IF NOT EXISTS idx_owner_loan_interest_company ON public.owner_loan_interest (company_id, income_year);

ALTER TABLE public.owner_loan_interest ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.owner_loan_interest TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.owner_loan_interest TO authenticated;
-- no-grant: anon on public.owner_loan_interest (company data)

DROP POLICY IF EXISTS "view own-company owner_loan_interest" ON public.owner_loan_interest;
CREATE POLICY "view own-company owner_loan_interest"
  ON public.owner_loan_interest FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company owner_loan_interest" ON public.owner_loan_interest;
CREATE POLICY "insert own-company owner_loan_interest"
  ON public.owner_loan_interest FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company owner_loan_interest" ON public.owner_loan_interest;
CREATE POLICY "update own-company owner_loan_interest"
  ON public.owner_loan_interest FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.owner_loan_interest;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.owner_loan_interest
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS owner_loan_interest_block_migration_reset_source_mutation ON public.owner_loan_interest;
CREATE TRIGGER owner_loan_interest_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.owner_loan_interest
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS set_updated_at_owner_loan_interest ON public.owner_loan_interest;
CREATE TRIGGER set_updated_at_owner_loan_interest
  BEFORE UPDATE ON public.owner_loan_interest
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_owner_loan_interest ON public.owner_loan_interest;
CREATE TRIGGER audit_owner_loan_interest
  AFTER INSERT OR UPDATE OR DELETE ON public.owner_loan_interest
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. ku20_specification_numbers
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ku20_specification_numbers (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  income_year           integer NOT NULL CHECK (income_year BETWEEN 2000 AND 2099),
  party_id              uuid NOT NULL,
  specification_number  bigint NOT NULL CHECK (specification_number BETWEEN 1 AND 9999999999),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ku20_spec_one_per_recipient UNIQUE (company_id, income_year, party_id),
  CONSTRAINT ku20_spec_unique_number UNIQUE (company_id, income_year, specification_number),
  CONSTRAINT ku20_spec_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.ku20_specification_numbers IS
  'KU20 field 570 per recipient and inkomstår, kept so a corrected file replaces the same kontrolluppgift.';

ALTER TABLE public.ku20_specification_numbers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ku20_specification_numbers TO service_role;
GRANT SELECT, INSERT ON TABLE public.ku20_specification_numbers TO authenticated;
-- no-grant: anon on public.ku20_specification_numbers (company data)

DROP POLICY IF EXISTS "view own-company ku20_specification_numbers" ON public.ku20_specification_numbers;
CREATE POLICY "view own-company ku20_specification_numbers"
  ON public.ku20_specification_numbers FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company ku20_specification_numbers" ON public.ku20_specification_numbers;
CREATE POLICY "insert own-company ku20_specification_numbers"
  ON public.ku20_specification_numbers FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.ku20_specification_numbers;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.ku20_specification_numbers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS ku20_specification_numbers_block_migration_reset_source_mutation ON public.ku20_specification_numbers;
CREATE TRIGGER ku20_specification_numbers_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.ku20_specification_numbers
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

-- =============================================================================
-- 5. pending_operations.operation_type: the owner tax staged writes
-- =============================================================================

DO $$
DECLARE
  v_types text[];
  v_new text;
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[
    'set_k10_owner_inputs', 'create_owner_loan', 'update_owner_loan', 'set_owner_loan_interest'
  ] LOOP
    IF NOT (v_new = ANY (v_types)) THEN
      v_types := v_types || v_new;
    END IF;
  END LOOP;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
