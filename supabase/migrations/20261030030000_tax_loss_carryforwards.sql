-- =============================================================================
-- Underskottsregistret: prior years' tax losses per fiscal year (IL 40 kap.)
--
-- One row per company and räkenskapsår for a company that files INK2. It
-- replaces retyping INK2S 4.14 a every year: the year's row says what was
-- brought forward (4.14 a), what a spärr cut off (4.14 b) or held back
-- (4.14 c), the year's result before the deduction, and what is carried to
-- the next year, which becomes the next row's 4.14 a. The figures are
-- computed in code (src/lib/bokslut/loss-carryforward/calculator.ts) and
-- stored as the user confirmed them; nothing here books a verifikat.
--
-- An ownership change (40:10-14) is stored on the row of the year it
-- happened: its date, which spärrar it triggers, and for the beloppsspärr
-- the utgift and the kapitaltillskott that reduce it (40:15-16). Today the
-- user enters it (ownership_change_source 'manual'); a share register can
-- later fill the same columns with 'aktiebok'.
--
-- No personal data: write_audit_log may copy the row.
--
-- pg-test: tests/pg/tax-loss-carryforwards.pg.test.ts
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.tax_loss_carryforwards (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL,
  -- INK2S 4.14 a: the whole deficit brought forward, spärrat or not.
  brought_forward numeric(15, 2) NOT NULL DEFAULT 0 CHECK (brought_forward >= 0),
  -- The year's result on INK2S before 4.14 (4.1 to 4.13); negative for a deficit, NULL while unknown.
  result_before_deficit numeric(15, 2),
  -- Koncernbidrag in that result that the koncernbidragsspärr keeps out of the ceiling (40:18-19).
  group_contributions_received numeric(15, 2) NOT NULL DEFAULT 0 CHECK (group_contributions_received >= 0),
  -- INK2S 4.14 b: cut off for good (beloppsspärr 40:15, 40:17 a, ackord or konkurs 40:20-21).
  amount_block_reduction numeric(15, 2) NOT NULL DEFAULT 0 CHECK (amount_block_reduction >= 0),
  amount_block_manual boolean NOT NULL DEFAULT false,
  -- INK2S 4.14 c: held back by the koncernbidragsspärr this year (40:18); carried on.
  group_block_reduction numeric(15, 2) NOT NULL DEFAULT 0 CHECK (group_block_reduction >= 0),
  group_block_manual boolean NOT NULL DEFAULT false,
  -- To the next year's 4.14 a (INK2 1.2: 4.16 plus 4.14 c); NULL while the result is unknown.
  carried_forward numeric(15, 2) CHECK (carried_forward IS NULL OR carried_forward >= 0),
  ownership_change_date date,
  ownership_change_source text CHECK (ownership_change_source IN ('manual', 'aktiebok')),
  amount_block_applies boolean NOT NULL DEFAULT false,
  -- Utgiften för att förvärva det bestämmande inflytandet (40:15).
  acquisition_cost numeric(15, 2) CHECK (acquisition_cost IS NULL OR acquisition_cost >= 0),
  -- Kapitaltillskott from at most two beskattningsår before the change year (40:16).
  capital_contributions numeric(15, 2) NOT NULL DEFAULT 0 CHECK (capital_contributions >= 0),
  group_block_applies boolean NOT NULL DEFAULT false,
  -- The last fiscal year (the calendar year it ends in) the koncernbidragsspärr covers.
  group_block_last_year integer CHECK (group_block_last_year IS NULL OR group_block_last_year BETWEEN 1900 AND 2200),
  -- Where brought_forward came from.
  source text NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'ink2_history', 'tax_assessment', 'computed')),
  note text CHECK (note IS NULL OR length(note) <= 2000),
  document_id uuid REFERENCES public.document_attachments(id) ON DELETE SET NULL,
  tax_assessment_notice_id uuid,
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tax_loss_carryforwards_period_key UNIQUE (company_id, fiscal_period_id),
  -- The period and the notice must be the same company's.
  CONSTRAINT tax_loss_carryforwards_fiscal_period_fkey
    FOREIGN KEY (fiscal_period_id, company_id)
    REFERENCES public.fiscal_periods (id, company_id) ON DELETE CASCADE,
  CONSTRAINT tax_loss_carryforwards_notice_fkey
    FOREIGN KEY (tax_assessment_notice_id, company_id)
    REFERENCES public.tax_assessment_notices (id, company_id) ON DELETE SET NULL (tax_assessment_notice_id),
  -- The spärrar never take more than was brought forward.
  CONSTRAINT tax_loss_carryforwards_reductions_check
    CHECK (amount_block_reduction + group_block_reduction <= brought_forward),
  -- An ownership change is a date and at least one spärr, never one without the other.
  CONSTRAINT tax_loss_carryforwards_ownership_change_check
    CHECK ((ownership_change_date IS NOT NULL) = (amount_block_applies OR group_block_applies)),
  CONSTRAINT tax_loss_carryforwards_ownership_source_check
    CHECK ((ownership_change_date IS NULL) = (ownership_change_source IS NULL)),
  CONSTRAINT tax_loss_carryforwards_amount_block_basis_check
    CHECK (amount_block_applies OR (acquisition_cost IS NULL AND capital_contributions = 0)),
  CONSTRAINT tax_loss_carryforwards_group_block_end_check
    CHECK (group_block_applies = (group_block_last_year IS NOT NULL))
);

COMMENT ON TABLE public.tax_loss_carryforwards IS
  'Underskottsregistret (IL 40 kap.): per räkenskapsår the deficit brought forward (INK2S 4.14 a), the spärrar (4.14 b, 4.14 c), the result before the deduction and the deficit carried forward.';

ALTER TABLE public.tax_loss_carryforwards ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tax_loss_carryforwards TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tax_loss_carryforwards TO authenticated;
-- no-grant: anon on public.tax_loss_carryforwards (a company's tax figures; no public surface reads them)

-- Members read; a writing member records in their own name. No DELETE
-- policy: a row is corrected by saving it again, never erased.
CREATE POLICY "view own-company tax_loss_carryforwards"
  ON public.tax_loss_carryforwards FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company tax_loss_carryforwards"
  ON public.tax_loss_carryforwards FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE POLICY "update own-company tax_loss_carryforwards"
  ON public.tax_loss_carryforwards FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.tax_loss_carryforwards
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

CREATE INDEX IF NOT EXISTS idx_tax_loss_carryforwards_fiscal_period
  ON public.tax_loss_carryforwards (fiscal_period_id);
CREATE INDEX IF NOT EXISTS idx_tax_loss_carryforwards_document
  ON public.tax_loss_carryforwards (document_id) WHERE document_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tax_loss_carryforwards_notice
  ON public.tax_loss_carryforwards (tax_assessment_notice_id) WHERE tax_assessment_notice_id IS NOT NULL;

CREATE TRIGGER set_updated_at_tax_loss_carryforwards
  BEFORE UPDATE ON public.tax_loss_carryforwards
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_tax_loss_carryforwards
  AFTER INSERT OR UPDATE OR DELETE ON public.tax_loss_carryforwards
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
