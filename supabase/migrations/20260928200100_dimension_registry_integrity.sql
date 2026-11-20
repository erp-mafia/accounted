-- Dimension registry integrity: a value keeps its identity, and a rule's
-- value belongs to the rule's own dimension and company.
--
-- 1. dimension_values.code, dimension_id and company_id become immutable.
--
--    Tagged lines never point at a value by id: journal_entry_lines.dimensions
--    stores the (sie_dim_no, code) pair as text, e.g. {"6":"P001"}. The only
--    UPDATE triggers on dimension_values were updated_at, the writer-role gate
--    and the audit log (20260702084500, 20260902093000), and the retention
--    guard fires on DELETE only. So a writer's direct PostgREST PATCH could
--    rename P001 to P002 (or move the row to another dimension, or to another
--    company the writer also belongs to): every posted line tagged P001 is
--    orphaned from the registry at once, and because the retention guard
--    looks the OLD code up on posted lines, the renamed value is then even
--    deletable. The application already treats code as immutable (the update
--    routes and the MCP tools only write name, is_active and the dates); the
--    database did not. This mirrors how dimensions.sie_dim_no is guarded
--    (enforce_dimension_registry_guards, 20260702084500, 20260807130000): a
--    BEFORE UPDATE trigger with a Swedish message, SQLSTATE P0001.
--
--    No legitimate writer changes these columns: the registry service,
--    the v1 and dashboard value routes, the MCP tools and the pending-
--    operations executor only INSERT or update name/is_active/dates;
--    the SIE import paths (TS importDimensionRegistry, SQL
--    apply_sie_import_metadata) and import-existing insert with ON CONFLICT
--    DO NOTHING; undo_sie_import, reset_fiscal_year and the sandbox teardown
--    (gnubok.sandbox_cleanup, 20260807130000) only DELETE. The one UPDATE a
--    cascade performs, parent_value_id ON DELETE SET NULL, touches none of
--    the three columns and passes. The trigger compares values instead of
--    listing columns (BEFORE UPDATE OF ...) so a SET that names a column
--    without changing it stays a no-op and nothing can slip past it.
--
-- 2. account_dimension_rules.value_id: same company AND same dimension.
--
--    The rule's value was referenced by id alone (20260703200000), so a rule
--    could point at another company's value, or at a value of a different
--    dimension than the rule's dimension_id; the original comment deferred
--    the composite key as "not worth the churn". The composite foreign key
--    (value_id, dimension_id, company_id) -> dimension_values (id,
--    dimension_id, company_id) makes both impossible by construction, the
--    same pattern the registry already uses for (dimension_id, company_id).
--    It needs the UNIQUE (id, dimension_id, company_id) target added below
--    (id alone is already unique, so this can never reject a row). MATCH
--    SIMPLE keeps 'required' rules (value_id NULL) valid, and ON DELETE
--    CASCADE is kept from the old key.
--
--    The constraint is replaced IN PLACE under its old name,
--    account_dimension_rules_value_id_fkey: PostgREST embeds hint on that
--    name (src/app/api/dimensions/rules/dto.ts and fetchActiveDimensionRules
--    in src/lib/bookkeeping/dimension-rules.ts). A new name would break the
--    rules API and make the engine skip every rule (its fetch fails open);
--    keeping the old key beside a new one would leave two relationships
--    between the tables. The DROP and the ADD are separate statements so
--    scripts/checks/ambiguous-embed.mjs derives exactly one edge.
--
--    Prod was checked on 2026-09-28 by the coordinator: the only rule has
--    value_id NULL, so validating the new key scans nothing that can fail.
--
-- dimension_values.parent_value_id is deliberately left alone (founder call,
-- DECISIONS.md 2026-09-27).
--
-- pg-test: tests/pg/dimensions-substrate.pg.test.ts (identity guard),
-- tests/pg/account-dimension-rules.pg.test.ts (composite key)

-- =============================================================================
-- 1. dimension_values identity guard
-- =============================================================================

CREATE OR REPLACE FUNCTION public.enforce_dimension_value_identity()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO 'public'
AS $$
BEGIN
  IF NEW.code IS DISTINCT FROM OLD.code THEN
    RAISE EXCEPTION 'Koden på ett dimensionsvärde kan inte ändras (rader är taggade med koden): skapa ett nytt värde och arkivera det gamla.';
  END IF;
  IF NEW.dimension_id IS DISTINCT FROM OLD.dimension_id
     OR NEW.company_id IS DISTINCT FROM OLD.company_id THEN
    RAISE EXCEPTION 'Ett dimensionsvärde kan inte flyttas till en annan dimension eller ett annat företag.';
  END IF;
  RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.enforce_dimension_value_identity() IS
  'dimension_values.code, dimension_id and company_id are immutable: tagged lines reference a value by (sie_dim_no, code) text, so a rename or move would orphan every posted tag (20260928200100).';

CREATE TRIGGER enforce_dimension_value_identity
  BEFORE UPDATE ON public.dimension_values
  FOR EACH ROW EXECUTE FUNCTION public.enforce_dimension_value_identity();

-- =============================================================================
-- 2. account_dimension_rules: composite value key
-- =============================================================================

ALTER TABLE public.dimension_values
  ADD CONSTRAINT dimension_values_id_dimension_id_company_id_key
  UNIQUE (id, dimension_id, company_id);

ALTER TABLE public.account_dimension_rules
  DROP CONSTRAINT account_dimension_rules_value_id_fkey;

ALTER TABLE public.account_dimension_rules
  ADD CONSTRAINT account_dimension_rules_value_id_fkey
  FOREIGN KEY (value_id, dimension_id, company_id)
  REFERENCES public.dimension_values (id, dimension_id, company_id)
  ON DELETE CASCADE;

NOTIFY pgrst, 'reload schema';
