-- =============================================================================
-- ne_declaration_inputs: what an enskild firma's owner enters for the
-- NE-bilaga's sida 2, one row per räkenskapsår
--
-- The NE-bilaga reads R1-R11 and the balansräkning from the books
-- (lib/reports/ne-bilaga). Sida 2 needs figures the books do not hold, which
-- the owner enters in the year-end step and which were kept only in the
-- browser until now: egenavgift category, kapitalunderlag för räntefördelning
-- and expansionsfond, sparat fördelningsbelopp, last year's schablonavdrag
-- (R40) and the egenavgifter charged (R41), the periodiseringsfonder of
-- earlier years, the expansionsfond and the avsättning or change wanted.
--
-- inputs holds them in the shape of the year-end preview's input
-- (EfDeclarationPreviewInput, lib/bokslut/enskild-firma); the app validates
-- every key and value, the CHECK holds the outline. Mutable by design while
-- the declaration is prepared, also after the year is closed (sida 2 is
-- prepared after bokslut); the audit trigger keeps every change in audit_log.
-- =============================================================================

CREATE TABLE public.ne_declaration_inputs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL,
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT ne_declaration_inputs_inputs_check
    CHECK (jsonb_typeof(inputs) = 'object' AND octet_length(inputs::text) <= 8192),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ne_declaration_inputs_period_key UNIQUE (company_id, fiscal_period_id),
  -- The period must be the same company's (fiscal_periods_id_company_id_key).
  CONSTRAINT ne_declaration_inputs_fiscal_period_fkey
    FOREIGN KEY (fiscal_period_id, company_id)
    REFERENCES public.fiscal_periods (id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.ne_declaration_inputs IS
  'Per räkenskapsår: the figures an enskild firma enters for the NE-bilaga sida 2 (egenavgifter, räntefördelning, periodiseringsfond, expansionsfond).';

CREATE INDEX idx_ne_declaration_inputs_fiscal_period
  ON public.ne_declaration_inputs (fiscal_period_id);

ALTER TABLE public.ne_declaration_inputs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ne_declaration_inputs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ne_declaration_inputs TO authenticated;
-- no-grant: anon on public.ne_declaration_inputs (an owner's tax return inputs; no public surface reads them)

-- Members read; a writing member records in their own name. No DELETE
-- policy: the inputs are cleared by saving empty values, never erased.
CREATE POLICY "view own-company ne_declaration_inputs"
  ON public.ne_declaration_inputs FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company ne_declaration_inputs"
  ON public.ne_declaration_inputs FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE POLICY "update own-company ne_declaration_inputs"
  ON public.ne_declaration_inputs FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.ne_declaration_inputs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER ne_declaration_inputs_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.ne_declaration_inputs
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER set_updated_at_ne_declaration_inputs
  BEFORE UPDATE ON public.ne_declaration_inputs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_ne_declaration_inputs
  AFTER INSERT OR UPDATE OR DELETE ON public.ne_declaration_inputs
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
