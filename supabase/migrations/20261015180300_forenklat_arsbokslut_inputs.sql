-- =============================================================================
-- forenklat_arsbokslut_inputs: what the förening adds to its förenklat
-- årsbokslut beyond the ledger, one row per räkenskapsår (#46)
--
-- The förenklat årsbokslut (BFL 6 kap. 3 § andra stycket and 6 §, BFNAR
-- 2010:1) is computed from the closed books. Three things cannot be read from
-- them and are stored here:
--
--   * The eligibility confirmation. An ideell förening may close its books
--     with a förenklat årsbokslut only when its nettoomsättning, counting
--     bidrag, gåvor and medlemsavgifter, is normally at most three million
--     kronor (BFL 6 kap. 3 §, 1 kap. 2 §), it is not a moderföretag and the
--     allmänt råd covers every verksamhet it runs (BFNAR 2010:1 1.1, 1.2). The
--     product cannot detect these, so a member confirms them for the year,
--     and the document carries its title only after that. Who and when are
--     kept on the row.
--   * Tilläggsupplysningar (BFNAR 2010:1 5.3), free text; ändamålsbestämda
--     medel may only be shown in a note to Eget kapital (6.67).
--   * The styrelseledamöter who sign (BFL 6 kap. 6 § with ÅRL 2 kap. 7 §):
--     one signature line and date line each. Signing happens on paper or
--     outside the product in this version.
--
-- Mutable by design while the document is prepared; the audit trigger keeps
-- every change in audit_log (behandlingshistorik).
-- =============================================================================

CREATE TABLE public.forenklat_arsbokslut_inputs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL REFERENCES public.fiscal_periods(id) ON DELETE CASCADE,
  -- Set together: who confirmed the BFL 6 kap. 3 § conditions for the year, and when.
  eligibility_confirmed_at timestamptz,
  eligibility_confirmed_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  notes text CHECK (notes IS NULL OR length(notes) <= 10000),
  -- [{ "name": text, "role": text | null }], in signing order.
  signatories jsonb NOT NULL DEFAULT '[]'::jsonb
    CHECK (jsonb_typeof(signatories) = 'array' AND jsonb_array_length(signatories) <= 30),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT forenklat_arsbokslut_inputs_period_key UNIQUE (company_id, fiscal_period_id),
  -- A confirmer always comes with a time; the time outlives a confirmer whose
  -- reference is cleared.
  CONSTRAINT forenklat_arsbokslut_inputs_confirmation_pair
    CHECK (eligibility_confirmed_by IS NULL OR eligibility_confirmed_at IS NOT NULL)
);

COMMENT ON TABLE public.forenklat_arsbokslut_inputs IS
  'Per räkenskapsår: the BFL 6 kap. 3 § eligibility confirmation, tilläggsupplysningar and signatories of an ideell förening''s förenklat årsbokslut (BFNAR 2010:1).';

CREATE INDEX idx_forenklat_arsbokslut_inputs_fiscal_period
  ON public.forenklat_arsbokslut_inputs (fiscal_period_id);

ALTER TABLE public.forenklat_arsbokslut_inputs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.forenklat_arsbokslut_inputs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.forenklat_arsbokslut_inputs TO authenticated;
-- no-grant: anon on public.forenklat_arsbokslut_inputs (a company's year-end inputs; no public surface reads them)

-- Members read; a writing member records in their own name. No DELETE
-- policy: the row is cleared field by field, never erased.
CREATE POLICY "view own-company forenklat_arsbokslut_inputs"
  ON public.forenklat_arsbokslut_inputs FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company forenklat_arsbokslut_inputs"
  ON public.forenklat_arsbokslut_inputs FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE POLICY "update own-company forenklat_arsbokslut_inputs"
  ON public.forenklat_arsbokslut_inputs FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.forenklat_arsbokslut_inputs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER forenklat_arsbokslut_inputs_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.forenklat_arsbokslut_inputs
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER set_updated_at_forenklat_arsbokslut_inputs
  BEFORE UPDATE ON public.forenklat_arsbokslut_inputs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_forenklat_arsbokslut_inputs
  AFTER INSERT OR UPDATE OR DELETE ON public.forenklat_arsbokslut_inputs
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
