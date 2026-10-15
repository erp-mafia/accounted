-- =============================================================================
-- ink3_underlag_inputs: what an ideell förening enters for its INK3 underlag,
-- one row per räkenskapsår (#47)
--
-- The INK3 underlag (lib/reports/ink3) reads the INK3R balance sheet and the
-- "enligt redovisningen" column from the books. Three things cannot be read
-- from them and are stored here (founder decisions on #47, 2026-10-15):
--
--   * allmannyttig: whether the förening is allmännyttig (IL 7 kap. 3 §). The
--     product never decides it; the user states it, and null means not yet
--     stated. It decides only whether INK3SUF belongs in the underlag.
--   * account_treatments: per income and cost account, whether it belongs to
--     the exempt activity, the taxable one, or both ({"3010": "taxable"}).
--     It builds the "som ska tas upp/dras av" column.
--   * field_overrides: the user's own figure for a ruta, by Skatteverket field
--     code ({"8671": 12000, "8822": true, "8620": "Text"}): any ruta except the
--     sums, and every INK3S and INK3SUF input.
--
-- The CHECKs hold the shape. Which codes exist and the value set of each
-- depend on the period's pinned field table and are checked by the app.
-- Mutable by design while the return is prepared, also after the year is
-- closed (the underlag is prepared after bokslut); the audit trigger keeps
-- every change in audit_log.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.ink3_account_treatments_valid(p_treatments jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_treatments) IS DISTINCT FROM 'object' THEN false
    ELSE (SELECT count(*) FROM jsonb_object_keys(p_treatments)) <= 2000
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_each(p_treatments) AS e
         WHERE e.key !~ '^[3-8][0-9]{3}$'
            OR jsonb_typeof(e.value) IS DISTINCT FROM 'string'
            OR (e.value #>> '{}') NOT IN ('exempt', 'taxable', 'shared')
      )
  END
$$;

COMMENT ON FUNCTION public.ink3_account_treatments_valid(jsonb) IS
  'CHECK helper for ink3_underlag_inputs.account_treatments: an object of result accounts (3000-8999) to exempt, taxable or shared.';

CREATE OR REPLACE FUNCTION public.ink3_field_overrides_valid(p_overrides jsonb)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog
AS $$
  SELECT CASE
    WHEN jsonb_typeof(p_overrides) IS DISTINCT FROM 'object' THEN false
    ELSE (SELECT count(*) FROM jsonb_object_keys(p_overrides)) <= 300
      AND NOT EXISTS (
        SELECT 1
          FROM jsonb_each(p_overrides) AS e
         WHERE e.key !~ '^[0-9]{4}$'
            OR NOT CASE jsonb_typeof(e.value)
                 WHEN 'number' THEN
                   (e.value::text)::numeric = trunc((e.value::text)::numeric)
                   AND abs((e.value::text)::numeric) <= 999999999999
                 WHEN 'boolean' THEN true
                 WHEN 'string' THEN length(e.value #>> '{}') BETWEEN 1 AND 36
                 ELSE false
               END
      )
  END
$$;

COMMENT ON FUNCTION public.ink3_field_overrides_valid(jsonb) IS
  'CHECK helper for ink3_underlag_inputs.field_overrides: an object of four-digit field codes to whole kronor, a ticked box, or text of at most 36 characters.';

CREATE TABLE public.ink3_underlag_inputs (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  fiscal_period_id uuid NOT NULL,
  allmannyttig boolean,
  account_treatments jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT ink3_underlag_inputs_account_treatments_check
    CHECK (public.ink3_account_treatments_valid(account_treatments)),
  field_overrides jsonb NOT NULL DEFAULT '{}'::jsonb
    CONSTRAINT ink3_underlag_inputs_field_overrides_check
    CHECK (public.ink3_field_overrides_valid(field_overrides)),
  updated_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT ink3_underlag_inputs_period_key UNIQUE (company_id, fiscal_period_id),
  -- The period must be the same company's (fiscal_periods_id_company_id_key).
  CONSTRAINT ink3_underlag_inputs_fiscal_period_fkey
    FOREIGN KEY (fiscal_period_id, company_id)
    REFERENCES public.fiscal_periods (id, company_id) ON DELETE CASCADE
);

COMMENT ON TABLE public.ink3_underlag_inputs IS
  'Per räkenskapsår: the allmännyttig statement, per-account exempt/taxable/shared treatment and per-ruta overrides of an ideell förening''s INK3 underlag.';

CREATE INDEX idx_ink3_underlag_inputs_fiscal_period
  ON public.ink3_underlag_inputs (fiscal_period_id);

ALTER TABLE public.ink3_underlag_inputs ENABLE ROW LEVEL SECURITY;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.ink3_underlag_inputs TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.ink3_underlag_inputs TO authenticated;
-- no-grant: anon on public.ink3_underlag_inputs (a company's tax return inputs; no public surface reads them)

-- Members read; a writing member records in their own name. No DELETE
-- policy: the inputs are cleared by saving empty values, never erased.
CREATE POLICY "view own-company ink3_underlag_inputs"
  ON public.ink3_underlag_inputs FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE POLICY "insert own-company ink3_underlag_inputs"
  ON public.ink3_underlag_inputs FOR INSERT
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE POLICY "update own-company ink3_underlag_inputs"
  ON public.ink3_underlag_inputs FOR UPDATE
  USING (company_id IN (SELECT public.user_company_ids()))
  WITH CHECK (
    company_id IN (SELECT public.user_company_ids())
    AND public.caller_can_write_company(company_id)
    AND updated_by = auth.uid()
  );

CREATE TRIGGER aa_enforce_company_writer_role
  BEFORE INSERT OR UPDATE OR DELETE ON public.ink3_underlag_inputs
  FOR EACH ROW EXECUTE FUNCTION public.enforce_company_writer_role();

-- Archived migration-reset source companies are static (20260818084050).
CREATE TRIGGER ink3_underlag_inputs_block_migration_reset_source_mutation
  BEFORE INSERT OR UPDATE OR DELETE ON public.ink3_underlag_inputs
  FOR EACH ROW EXECUTE FUNCTION public.block_migration_reset_source_mutation();

CREATE TRIGGER set_updated_at_ink3_underlag_inputs
  BEFORE UPDATE ON public.ink3_underlag_inputs
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE TRIGGER audit_ink3_underlag_inputs
  AFTER INSERT OR UPDATE OR DELETE ON public.ink3_underlag_inputs
  FOR EACH ROW EXECUTE FUNCTION public.write_audit_log();

NOTIFY pgrst, 'reload schema';
