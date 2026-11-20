-- =============================================================================
-- Bolaget, wave 3: capital events wired to the books
--
--   1. dividends: a vinstutdelning decided by the stämma (ABL 18 kap.), with
--      the date that decides who receives it, the betalningsdag (18:3), the
--      check against fritt eget kapital (17:3) as it stood when booked, and
--      the two verifikat the engine posted: the decision (2098 or 2091 to
--      2898) and the payout (2898 to bank). Status decided -> booked -> paid
--      (or cancelled before booking). Once booked the decision's figures
--      never change; a mistake is corrected in the ledger by storno.
--   2. dividend_distributions: one row per holder from the aktiebok on the
--      decisive date (amount to the öre, the remainder rule in
--      lib/bolaget/capital/dividend-math.ts). Frozen once the dividend leaves
--      'decided'.
--   3. ku31_filings: per company and inkomstår, the fåmansföretag answer the
--      user confirmed (field 061 or 062) and the KU31 contact person.
--   4. ku31_specification_numbers: field 570 per recipient and year, kept
--      so a corrected file replaces the same kontrolluppgift.
--   5. shareholder_contributions: aktieägartillskott (K2 15.5-15.6),
--      villkorat or ovillkorat, and repayments of a villkorat one.
--   6. capital_changes: nyemission (13 kap.), fondemission (12 kap.) and
--      minskning av aktiekapitalet (20 kap.), with their registration date
--      and verifikat.
--   7. pending_operations.operation_type: the capital staged writes,
--      expanded from the constraint's current definition, NOT VALID; the
--      VALIDATE runs in 20261030020100.
--
-- No personnummer is stored here: KU31 reads it from party_person_private
-- (service role) when an owner or administrator downloads the file. Every
-- verifikat is posted by the bookkeeping engine; these tables only point at
-- them (ON DELETE SET NULL, as finance_leases.initial_entry_id).
--
-- pg-test: tests/pg/capital-events.pg.test.ts
-- =============================================================================

SELECT set_config('lock_timeout', '5s', true);

-- =============================================================================
-- 1. dividends
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.dividends (
  id                  uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id          uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  decided_on          date NOT NULL,
  -- Only a bolagsstämma decides a vinstutdelning (ABL 18:1).
  decided_by          text NOT NULL CHECK (decided_by IN ('arsstamma', 'extra_stamma')),
  -- The stämma decision (corporate_decisions, a later wave). No FK on purpose.
  decision_id         uuid,
  document_id         uuid,
  -- register: split from the aktiebok; ledger: recipients entered by hand for
  -- a dividend booked before the aktiebok existed.
  origin              text NOT NULL DEFAULT 'register' CHECK (origin IN ('register', 'ledger')),
  -- NULL: every class.
  share_class_ids     uuid[],
  amount_per_share    numeric(20, 6) CHECK (amount_per_share IS NULL OR amount_per_share > 0),
  total_amount        numeric(15, 2) NOT NULL CHECK (total_amount > 0),
  -- The day whose aktiebok decides who receives the dividend, and why that day.
  record_date         date NOT NULL,
  record_date_basis   text NOT NULL CHECK (record_date_basis IN ('decision_date', 'payment_date', 'other')),
  -- The betalningsdag the decision states (ABL 18:3).
  payment_date        date NOT NULL,
  -- The equity account the decision is booked from.
  source_account      text CHECK (source_account IN ('2091', '2098')),
  prudence_confirmed  boolean NOT NULL DEFAULT false,
  -- The fritt eget kapital check (ABL 17:3) as it stood when booked.
  equity_check        jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(equity_check) = 'object'),
  status              text NOT NULL DEFAULT 'decided' CHECK (status IN ('decided', 'booked', 'paid', 'cancelled')),
  decision_entry_id   uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  payout_entry_id     uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  paid_on             date,
  note                text CHECK (note IS NULL OR length(note) <= 2000),
  created_by          uuid REFERENCES auth.users(id),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dividends_id_company UNIQUE (id, company_id),
  CHECK (payment_date >= decided_on),
  CHECK (status <> 'paid' OR paid_on IS NOT NULL)
);

COMMENT ON TABLE public.dividends IS
  'Vinstutdelning decided by the bolagsstämma (ABL 18 kap.), checked against fritt eget kapital (17:3) and booked through the engine. Never deleted; booked figures never change.';

CREATE INDEX IF NOT EXISTS idx_dividends_company ON public.dividends (company_id, decided_on);

-- The figures of a booked dividend never change; the status only moves
-- forward; a dividend is cancelled, never deleted. An FK action (a journal
-- entry removed, a company deleted) runs inside a trigger and passes.
CREATE OR REPLACE FUNCTION public.dividends_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'DIVIDEND_APPEND_ONLY: a dividend is cancelled, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.origin IS DISTINCT FROM OLD.origin THEN
    RAISE EXCEPTION 'DIVIDEND_APPEND_ONLY: who and where a dividend came from never change'
      USING ERRCODE = 'check_violation';
  END IF;
  -- A booking claims its step first (decided -> booked, booked -> paid) and
  -- writes the verifikat id after the engine posted it, so two approvals
  -- racing each other cannot both post. A claim whose posting failed (no
  -- verifikat id yet) is released back one step; nothing else goes back.
  IF OLD.status = 'paid' AND NEW.status IS DISTINCT FROM OLD.status
     AND NOT (NEW.status = 'booked' AND OLD.payout_entry_id IS NULL AND OLD.origin = 'register') THEN
    RAISE EXCEPTION 'DIVIDEND_STATUS_INVALID: a paid dividend does not change status'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'DIVIDEND_STATUS_INVALID: a cancelled dividend does not change status'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'booked' AND NEW.status NOT IN ('booked', 'paid')
     AND NOT (NEW.status = 'decided' AND OLD.decision_entry_id IS NULL AND OLD.origin = 'register') THEN
    RAISE EXCEPTION 'DIVIDEND_STATUS_INVALID: a booked dividend can only be paid'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status <> 'decided' AND NEW.status <> 'decided' THEN
    IF NEW.decided_on IS DISTINCT FROM OLD.decided_on
       OR NEW.decided_by IS DISTINCT FROM OLD.decided_by
       OR NEW.share_class_ids IS DISTINCT FROM OLD.share_class_ids
       OR NEW.amount_per_share IS DISTINCT FROM OLD.amount_per_share
       OR NEW.total_amount IS DISTINCT FROM OLD.total_amount
       OR NEW.record_date IS DISTINCT FROM OLD.record_date
       OR NEW.record_date_basis IS DISTINCT FROM OLD.record_date_basis
       OR NEW.payment_date IS DISTINCT FROM OLD.payment_date
       OR NEW.source_account IS DISTINCT FROM OLD.source_account
       OR NEW.prudence_confirmed IS DISTINCT FROM OLD.prudence_confirmed
       OR NEW.equity_check IS DISTINCT FROM OLD.equity_check
       OR (OLD.decision_entry_id IS NOT NULL AND NEW.decision_entry_id IS DISTINCT FROM OLD.decision_entry_id)
       OR (OLD.decision_id IS NOT NULL AND NEW.decision_id IS DISTINCT FROM OLD.decision_id)
       OR (OLD.payout_entry_id IS NOT NULL AND NEW.payout_entry_id IS DISTINCT FROM OLD.payout_entry_id)
       OR (OLD.payout_entry_id IS NOT NULL AND NEW.paid_on IS DISTINCT FROM OLD.paid_on) THEN
      RAISE EXCEPTION 'DIVIDEND_FROZEN: a booked dividend keeps its decision; correct the verifikat by storno'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.dividends_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.dividends ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dividends TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.dividends TO authenticated;
-- no-grant: anon on public.dividends (company data)

DROP POLICY IF EXISTS "view own-company dividends" ON public.dividends;
CREATE POLICY "view own-company dividends"
  ON public.dividends FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company dividends" ON public.dividends;
CREATE POLICY "insert own-company dividends"
  ON public.dividends FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company dividends" ON public.dividends;
CREATE POLICY "update own-company dividends"
  ON public.dividends FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.dividends;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.dividends
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS dividends_block_migration_reset_source_mutation ON public.dividends;
CREATE TRIGGER dividends_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.dividends
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS dividends_guard ON public.dividends;
CREATE TRIGGER dividends_guard
  BEFORE UPDATE OR DELETE ON public.dividends
  FOR EACH ROW EXECUTE FUNCTION public.dividends_guard();
DROP TRIGGER IF EXISTS set_updated_at_dividends ON public.dividends;
CREATE TRIGGER set_updated_at_dividends
  BEFORE UPDATE ON public.dividends
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_dividends ON public.dividends;
CREATE TRIGGER audit_dividends
  AFTER INSERT OR UPDATE OR DELETE ON public.dividends
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 2. dividend_distributions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.dividend_distributions (
  id           uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id   uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  dividend_id  uuid NOT NULL,
  party_id     uuid NOT NULL,
  share_count  bigint NOT NULL CHECK (share_count >= 0),
  amount       numeric(15, 2) NOT NULL CHECK (amount > 0),
  -- [{ share_class_id, code, shares }] on the decisive date.
  by_class     jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(by_class) = 'array'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT dividend_distributions_one_per_holder UNIQUE (dividend_id, party_id),
  CONSTRAINT dividend_distributions_dividend_same_company
    FOREIGN KEY (dividend_id, company_id) REFERENCES public.dividends(id, company_id) ON DELETE CASCADE,
  CONSTRAINT dividend_distributions_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id)
);

COMMENT ON TABLE public.dividend_distributions IS
  'Each holder''s part of a dividend from the aktiebok on the decisive date. Frozen once the dividend is booked.';

CREATE INDEX IF NOT EXISTS idx_dividend_distributions_dividend ON public.dividend_distributions (dividend_id);
CREATE INDEX IF NOT EXISTS idx_dividend_distributions_party ON public.dividend_distributions (party_id);

-- The split changes only while the dividend is decided. A cascade from the
-- dividend or the company runs inside a trigger and passes.
CREATE OR REPLACE FUNCTION public.dividend_distributions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_dividend uuid;
  v_status text;
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  v_dividend := CASE WHEN TG_OP = 'DELETE' THEN OLD.dividend_id ELSE NEW.dividend_id END;
  SELECT status INTO v_status FROM public.dividends WHERE id = v_dividend;
  IF v_status IS DISTINCT FROM 'decided' THEN
    RAISE EXCEPTION 'DIVIDEND_FROZEN: the split of a booked dividend never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.dividend_id IS DISTINCT FROM OLD.dividend_id THEN
    SELECT status INTO v_status FROM public.dividends WHERE id = OLD.dividend_id;
    IF v_status IS DISTINCT FROM 'decided' THEN
      RAISE EXCEPTION 'DIVIDEND_FROZEN: the split of a booked dividend never changes'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

REVOKE ALL ON FUNCTION public.dividend_distributions_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.dividend_distributions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dividend_distributions TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.dividend_distributions TO authenticated;
-- no-grant: anon on public.dividend_distributions (company data)

DROP POLICY IF EXISTS "view own-company dividend_distributions" ON public.dividend_distributions;
CREATE POLICY "view own-company dividend_distributions"
  ON public.dividend_distributions FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company dividend_distributions" ON public.dividend_distributions;
CREATE POLICY "insert own-company dividend_distributions"
  ON public.dividend_distributions FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company dividend_distributions" ON public.dividend_distributions;
CREATE POLICY "update own-company dividend_distributions"
  ON public.dividend_distributions FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));
DROP POLICY IF EXISTS "delete own-company dividend_distributions" ON public.dividend_distributions;
CREATE POLICY "delete own-company dividend_distributions"
  ON public.dividend_distributions FOR DELETE USING (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.dividend_distributions;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.dividend_distributions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS dividend_distributions_block_migration_reset_source_mutation ON public.dividend_distributions;
CREATE TRIGGER dividend_distributions_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.dividend_distributions
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS dividend_distributions_guard ON public.dividend_distributions;
CREATE TRIGGER dividend_distributions_guard
  BEFORE INSERT OR UPDATE OR DELETE ON public.dividend_distributions
  FOR EACH ROW EXECUTE FUNCTION public.dividend_distributions_guard();
DROP TRIGGER IF EXISTS audit_dividend_distributions ON public.dividend_distributions;
CREATE TRIGGER audit_dividend_distributions
  AFTER INSERT OR UPDATE OR DELETE ON public.dividend_distributions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 3. ku31_filings
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ku31_filings (
  id                          uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id                  uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  income_year                 integer NOT NULL CHECK (income_year BETWEEN 2000 AND 2099),
  -- The answer the user confirmed: true marks field 061, false field 062.
  famansforetag               boolean,
  -- What the aktiebok suggested when the user answered (IL 56:2, votes only).
  famansforetag_derived       boolean,
  famansforetag_confirmed_by  uuid REFERENCES auth.users(id),
  famansforetag_confirmed_at  timestamptz,
  -- Kontaktperson (Blankettgemensamt) of the file.
  contact_name                text CHECK (contact_name IS NULL OR length(contact_name) BETWEEN 1 AND 50),
  contact_phone               text CHECK (contact_phone IS NULL OR length(contact_phone) BETWEEN 1 AND 20),
  contact_email               text CHECK (contact_email IS NULL OR length(contact_email) BETWEEN 3 AND 254),
  last_generated_at           timestamptz,
  last_generated_by           uuid REFERENCES auth.users(id),
  created_at                  timestamptz NOT NULL DEFAULT now(),
  updated_at                  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ku31_filings_one_per_year UNIQUE (company_id, income_year)
);

COMMENT ON TABLE public.ku31_filings IS
  'Per inkomstår: the confirmed fåmansföretag answer (KU31 field 061/062) and the contact person of the KU31 file.';

ALTER TABLE public.ku31_filings ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ku31_filings TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ku31_filings TO authenticated;
-- no-grant: anon on public.ku31_filings (company data)

DROP POLICY IF EXISTS "view own-company ku31_filings" ON public.ku31_filings;
CREATE POLICY "view own-company ku31_filings"
  ON public.ku31_filings FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company ku31_filings" ON public.ku31_filings;
CREATE POLICY "insert own-company ku31_filings"
  ON public.ku31_filings FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company ku31_filings" ON public.ku31_filings;
CREATE POLICY "update own-company ku31_filings"
  ON public.ku31_filings FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.ku31_filings;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.ku31_filings
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS ku31_filings_block_migration_reset_source_mutation ON public.ku31_filings;
CREATE TRIGGER ku31_filings_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.ku31_filings
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS set_updated_at_ku31_filings ON public.ku31_filings;
CREATE TRIGGER set_updated_at_ku31_filings
  BEFORE UPDATE ON public.ku31_filings
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_ku31_filings ON public.ku31_filings;
CREATE TRIGGER audit_ku31_filings
  AFTER INSERT OR UPDATE OR DELETE ON public.ku31_filings
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 4. ku31_specification_numbers
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.ku31_specification_numbers (
  id                    uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id            uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  income_year           integer NOT NULL CHECK (income_year BETWEEN 2000 AND 2099),
  party_id              uuid NOT NULL,
  specification_number  bigint NOT NULL CHECK (specification_number BETWEEN 1 AND 9999999999),
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ku31_spec_one_per_recipient UNIQUE (company_id, income_year, party_id),
  CONSTRAINT ku31_spec_unique_number UNIQUE (company_id, income_year, specification_number),
  CONSTRAINT ku31_spec_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.ku31_specification_numbers IS
  'KU31 field 570 per recipient and inkomstår, kept so a corrected file replaces the same kontrolluppgift.';

ALTER TABLE public.ku31_specification_numbers ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ku31_specification_numbers TO service_role;
GRANT SELECT, INSERT ON TABLE public.ku31_specification_numbers TO authenticated;
-- no-grant: anon on public.ku31_specification_numbers (company data)

DROP POLICY IF EXISTS "view own-company ku31_specification_numbers" ON public.ku31_specification_numbers;
CREATE POLICY "view own-company ku31_specification_numbers"
  ON public.ku31_specification_numbers FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company ku31_specification_numbers" ON public.ku31_specification_numbers;
CREATE POLICY "insert own-company ku31_specification_numbers"
  ON public.ku31_specification_numbers FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.ku31_specification_numbers;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.ku31_specification_numbers
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS ku31_specification_numbers_block_migration_reset_source_mutation ON public.ku31_specification_numbers;
CREATE TRIGGER ku31_specification_numbers_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.ku31_specification_numbers
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

-- =============================================================================
-- 5. shareholder_contributions
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.shareholder_contributions (
  id                      uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id              uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  party_id                uuid NOT NULL,
  kind                    text NOT NULL CHECK (kind IN ('contribution', 'repayment')),
  -- A repayment points at the villkorat tillskott it repays.
  repays_contribution_id  uuid REFERENCES public.shareholder_contributions(id) ON DELETE SET NULL,
  -- The utfästelse (K2 15.5) for a contribution; the payment day for a repayment.
  promised_on             date NOT NULL,
  amount                  numeric(15, 2) NOT NULL CHECK (amount > 0),
  conditional             boolean NOT NULL,
  -- A repayment of a villkorat tillskott needs a stämma decision (K2 15.6).
  decided_on              date,
  decided_by              text CHECK (decided_by IS NULL OR decided_by IN ('arsstamma', 'extra_stamma', 'styrelse')),
  decision_id             uuid,
  document_id             uuid,
  -- The account booked against 2093: a bank account (19xx) when paid, or
  -- 1685 Kortfristiga fordringar hos delägare while only promised.
  counter_account         text NOT NULL DEFAULT '1930' CHECK (counter_account ~ '^(19[0-9][0-9]|1685)$'),
  journal_entry_id        uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  status                  text NOT NULL DEFAULT 'booked' CHECK (status IN ('registered', 'booked', 'cancelled')),
  note                    text CHECK (note IS NULL OR length(note) <= 2000),
  created_by              uuid REFERENCES auth.users(id),
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  CHECK (kind = 'repayment' OR repays_contribution_id IS NULL),
  CONSTRAINT shareholder_contributions_party_same_company
    FOREIGN KEY (party_id, company_id) REFERENCES public.parties(id, company_id)
);

COMMENT ON TABLE public.shareholder_contributions IS
  'Aktieägartillskott (K2 15.5-15.6): who, when promised, amount, villkorat or not, and the verifikat. Never deleted.';

CREATE INDEX IF NOT EXISTS idx_shareholder_contributions_company ON public.shareholder_contributions (company_id, promised_on);
CREATE INDEX IF NOT EXISTS idx_shareholder_contributions_party ON public.shareholder_contributions (party_id);

CREATE OR REPLACE FUNCTION public.shareholder_contributions_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CONTRIBUTION_APPEND_ONLY: a shareholder contribution is cancelled, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'booked' AND (
       NEW.company_id IS DISTINCT FROM OLD.company_id
       OR NEW.party_id IS DISTINCT FROM OLD.party_id
       OR NEW.kind IS DISTINCT FROM OLD.kind
       OR NEW.repays_contribution_id IS DISTINCT FROM OLD.repays_contribution_id
       OR NEW.promised_on IS DISTINCT FROM OLD.promised_on
       OR NEW.amount IS DISTINCT FROM OLD.amount
       OR NEW.conditional IS DISTINCT FROM OLD.conditional
       OR NEW.counter_account IS DISTINCT FROM OLD.counter_account
       OR NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       OR NEW.status IS DISTINCT FROM OLD.status
       OR NEW.created_by IS DISTINCT FROM OLD.created_by
       OR NEW.created_at IS DISTINCT FROM OLD.created_at) THEN
    RAISE EXCEPTION 'CONTRIBUTION_FROZEN: a booked shareholder contribution keeps its figures; correct the verifikat by storno'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status = 'cancelled' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'CONTRIBUTION_FROZEN: a cancelled shareholder contribution stays cancelled'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.shareholder_contributions_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.shareholder_contributions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.shareholder_contributions TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.shareholder_contributions TO authenticated;
-- no-grant: anon on public.shareholder_contributions (company data)

DROP POLICY IF EXISTS "view own-company shareholder_contributions" ON public.shareholder_contributions;
CREATE POLICY "view own-company shareholder_contributions"
  ON public.shareholder_contributions FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company shareholder_contributions" ON public.shareholder_contributions;
CREATE POLICY "insert own-company shareholder_contributions"
  ON public.shareholder_contributions FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company shareholder_contributions" ON public.shareholder_contributions;
CREATE POLICY "update own-company shareholder_contributions"
  ON public.shareholder_contributions FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.shareholder_contributions;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.shareholder_contributions
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS shareholder_contributions_block_migration_reset_source_mutation ON public.shareholder_contributions;
CREATE TRIGGER shareholder_contributions_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.shareholder_contributions
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS shareholder_contributions_guard ON public.shareholder_contributions;
CREATE TRIGGER shareholder_contributions_guard
  BEFORE UPDATE OR DELETE ON public.shareholder_contributions
  FOR EACH ROW EXECUTE FUNCTION public.shareholder_contributions_guard();
DROP TRIGGER IF EXISTS set_updated_at_shareholder_contributions ON public.shareholder_contributions;
CREATE TRIGGER set_updated_at_shareholder_contributions
  BEFORE UPDATE ON public.shareholder_contributions
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_shareholder_contributions ON public.shareholder_contributions;
CREATE TRIGGER audit_shareholder_contributions
  AFTER INSERT OR UPDATE OR DELETE ON public.shareholder_contributions
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 6. capital_changes
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.capital_changes (
  id                     uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id             uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  kind                   text NOT NULL CHECK (kind IN ('nyemission', 'fondemission', 'minskning')),
  decided_on             date NOT NULL,
  decided_by             text NOT NULL CHECK (decided_by IN ('arsstamma', 'extra_stamma', 'styrelse')),
  decision_id            uuid,
  document_id            uuid,
  -- The share class (share_classes.id); no FK, the aktiebok events carry it.
  share_class_id         uuid,
  -- New shares (emission) or cancelled shares (minskning); 0 when only the
  -- kvotvärde changes.
  share_count            bigint NOT NULL CHECK (share_count >= 0),
  -- The change of aktiekapital (2081), always positive.
  share_capital_amount   numeric(15, 2) NOT NULL CHECK (share_capital_amount > 0),
  -- Nyemission: the price per share and the överkurs above the kvotvärde.
  price_per_share        numeric(20, 6) CHECK (price_per_share IS NULL OR price_per_share > 0),
  premium_amount         numeric(15, 2) NOT NULL DEFAULT 0 CHECK (premium_amount >= 0),
  subscription_start     date,
  subscription_end       date,
  -- Fondemission: the fund the increase is taken from (ABL 12:1).
  source_account         text CHECK (source_account IS NULL OR source_account IN ('2085', '2086', '2091', '2097')),
  -- Minskning: the purpose (ABL 20:1) and where the amount goes.
  purpose                text CHECK (purpose IS NULL OR purpose IN ('forlusttackning', 'aterbetalning', 'fri_fond')),
  target_account         text CHECK (target_account IS NULL OR target_account IN ('2091', '2890')),
  -- Allotment per subscriber (nyemission): [{ party_id, share_count, amount, share_register_event_id }].
  allotments             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(allotments) = 'array'),
  -- The day Bolagsverket registered the decision (13:29, 12:10, 20:20).
  registered_on          date,
  payment_entry_id       uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  registration_entry_id  uuid REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  status                 text NOT NULL DEFAULT 'decided' CHECK (status IN ('decided', 'registered', 'cancelled')),
  note                   text CHECK (note IS NULL OR length(note) <= 2000),
  created_by             uuid REFERENCES auth.users(id),
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'fondemission' OR source_account IS NOT NULL),
  CHECK (kind <> 'minskning' OR (purpose IS NOT NULL AND target_account IS NOT NULL)),
  CHECK (kind = 'nyemission' OR premium_amount = 0),
  CHECK (status <> 'registered' OR registered_on IS NOT NULL),
  CHECK (subscription_end IS NULL OR subscription_start IS NULL OR subscription_end >= subscription_start)
);

COMMENT ON TABLE public.capital_changes IS
  'Nyemission (ABL 13 kap.), fondemission (12 kap.) and minskning av aktiekapitalet (20 kap.): decision, registration and the verifikat. Never deleted.';

CREATE INDEX IF NOT EXISTS idx_capital_changes_company ON public.capital_changes (company_id, decided_on);

CREATE OR REPLACE FUNCTION public.capital_changes_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF pg_trigger_depth() > 1 OR current_setting('gnubok.allow_delete', true) = 'true' THEN
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'CAPITAL_CHANGE_APPEND_ONLY: a capital change is cancelled, never deleted'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.company_id IS DISTINCT FROM OLD.company_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'CAPITAL_CHANGE_APPEND_ONLY: what a capital change is never changes'
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.status IN ('registered', 'cancelled') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'CAPITAL_CHANGE_FROZEN: a % capital change keeps its status', OLD.status
      USING ERRCODE = 'check_violation';
  END IF;
  -- Once money was booked or the change registered, the figures stay.
  IF (OLD.payment_entry_id IS NOT NULL OR OLD.status = 'registered') AND (
       NEW.decided_on IS DISTINCT FROM OLD.decided_on
       OR NEW.share_count IS DISTINCT FROM OLD.share_count
       OR NEW.share_capital_amount IS DISTINCT FROM OLD.share_capital_amount
       OR NEW.price_per_share IS DISTINCT FROM OLD.price_per_share
       OR NEW.premium_amount IS DISTINCT FROM OLD.premium_amount
       OR NEW.source_account IS DISTINCT FROM OLD.source_account
       OR NEW.purpose IS DISTINCT FROM OLD.purpose
       OR NEW.target_account IS DISTINCT FROM OLD.target_account
       OR (OLD.payment_entry_id IS NOT NULL AND NEW.payment_entry_id IS DISTINCT FROM OLD.payment_entry_id)
       OR (OLD.registration_entry_id IS NOT NULL AND NEW.registration_entry_id IS DISTINCT FROM OLD.registration_entry_id)
       OR (OLD.registered_on IS NOT NULL AND NEW.registered_on IS DISTINCT FROM OLD.registered_on)) THEN
    RAISE EXCEPTION 'CAPITAL_CHANGE_FROZEN: a booked capital change keeps its figures; correct the verifikat by storno'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.capital_changes_guard() FROM PUBLIC, anon, authenticated;

ALTER TABLE public.capital_changes ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.capital_changes TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.capital_changes TO authenticated;
-- no-grant: anon on public.capital_changes (company data)

DROP POLICY IF EXISTS "view own-company capital_changes" ON public.capital_changes;
CREATE POLICY "view own-company capital_changes"
  ON public.capital_changes FOR SELECT USING (company_id IN (SELECT public.user_company_ids()));
DROP POLICY IF EXISTS "insert own-company capital_changes" ON public.capital_changes;
CREATE POLICY "insert own-company capital_changes"
  ON public.capital_changes FOR INSERT WITH CHECK (
    company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id)
  );
DROP POLICY IF EXISTS "update own-company capital_changes" ON public.capital_changes;
CREATE POLICY "update own-company capital_changes"
  ON public.capital_changes FOR UPDATE USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (company_id IN (SELECT public.user_company_ids()) AND public.caller_can_write_company(company_id));

DROP TRIGGER IF EXISTS aa_enforce_company_writer_role ON public.capital_changes;
CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.capital_changes
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();
DROP TRIGGER IF EXISTS capital_changes_block_migration_reset_source_mutation ON public.capital_changes;
CREATE TRIGGER capital_changes_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.capital_changes
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();
DROP TRIGGER IF EXISTS capital_changes_guard ON public.capital_changes;
CREATE TRIGGER capital_changes_guard
  BEFORE UPDATE OR DELETE ON public.capital_changes
  FOR EACH ROW EXECUTE FUNCTION public.capital_changes_guard();
DROP TRIGGER IF EXISTS set_updated_at_capital_changes ON public.capital_changes;
CREATE TRIGGER set_updated_at_capital_changes
  BEFORE UPDATE ON public.capital_changes
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();
DROP TRIGGER IF EXISTS audit_capital_changes ON public.capital_changes;
CREATE TRIGGER audit_capital_changes
  AFTER INSERT OR UPDATE OR DELETE ON public.capital_changes
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

-- =============================================================================
-- 7. pending_operations.operation_type: the capital staged writes
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
    'create_dividend', 'book_dividend', 'pay_dividend',
    'create_shareholder_contribution', 'create_capital_change', 'book_capital_change'
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
