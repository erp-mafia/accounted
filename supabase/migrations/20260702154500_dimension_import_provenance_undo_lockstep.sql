-- Dimensions plan PR5 (SIE round-trip): registry provenance + undo lockstep.
--
-- SIE import now creates `dimensions`/`dimension_values` rows (#DIM /
-- #UNDERDIM / #OBJEKT / object-list references). undo_sie_import previously
-- only deleted the import's journal entries — the registry rows it introduced
-- would linger as orphans. Two changes:
--
--   1. `created_by_import_id` provenance on both registry tables (NULL for
--      user-created rows; ON DELETE SET NULL so deleting an old sie_imports
--      row never cascades into the registry).
--   2. undo_sie_import deletes the values/dimensions the undone import
--      created, but ONLY when no remaining posted/reversed line references
--      them — user-created rows and rows referenced by other imports or
--      manual bookkeeping are untouched. The registry guard triggers
--      (enforce_dimension_registry_guards / enforce_dimension_value_retention)
--      run on these deletes as a backstop: the WHERE clauses mirror their
--      reference checks, so they only fire if a concurrent write tagged a
--      line between check and delete — in which case aborting the undo is
--      the correct outcome.
--
-- replace_sie_import intentionally does NOT get the lockstep: replace is
-- undo + immediate re-import of the same fiscal year, and the re-import
-- re-upserts the same codes — deleting them in between would only churn ids
-- that MCP/agent flows may hold. Stale values from a replaced file remain
-- inactivatable via the register UI.
--
-- pg-test: lib/import/__tests__/undo-sie-import-dimensions.pg.test.ts

ALTER TABLE public.dimensions
  ADD COLUMN created_by_import_id uuid REFERENCES public.sie_imports(id) ON DELETE SET NULL;

ALTER TABLE public.dimension_values
  ADD COLUMN created_by_import_id uuid REFERENCES public.sie_imports(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.dimensions.created_by_import_id IS
  'SIE import that introduced this dimension (NULL = user-created). Undo deletes import-created rows that ended up unreferenced.';
COMMENT ON COLUMN public.dimension_values.created_by_import_id IS
  'SIE import that introduced this value (NULL = user-created). Undo deletes import-created rows that ended up unreferenced.';

-- Undo looks rows up by import id; partial indexes keep the common case
-- (user-created rows, NULL) out of the index entirely.
CREATE INDEX idx_dimensions_created_by_import
  ON public.dimensions (created_by_import_id)
  WHERE created_by_import_id IS NOT NULL;
CREATE INDEX idx_dimension_values_created_by_import
  ON public.dimension_values (created_by_import_id)
  WHERE created_by_import_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.undo_sie_import(
  p_company_id uuid,
  p_import_id  uuid,
  p_user_id    uuid DEFAULT NULL
)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 -- CREATE OR REPLACE resets proconfig, so the function-local timeout from
 -- 20260629160100 must be restated here or the service-client bulk delete
 -- regresses to the authenticator role's 8s limit (pinned by
 -- sie-import.replace.pg.test.ts).
 SET statement_timeout TO '290s'
AS $function$
DECLARE
  v_fiscal_period_id          uuid;
  v_opening_balance_entry_id  uuid;
  v_is_closed                 boolean;
  v_locked_at                 timestamptz;
  v_deleted                   integer := 0;
  v_caller_role               text;
  v_actor                     uuid := COALESCE(p_user_id, auth.uid());
BEGIN
  SELECT cm.role INTO v_caller_role
  FROM company_members cm
  WHERE cm.company_id = p_company_id
    AND cm.user_id = v_actor;

  IF v_caller_role IS NULL OR v_caller_role NOT IN ('owner', 'admin') THEN
    RAISE EXCEPTION 'Only company owners and admins can undo SIE imports';
  END IF;

  SELECT fiscal_period_id, opening_balance_entry_id
    INTO v_fiscal_period_id, v_opening_balance_entry_id
    FROM public.sie_imports
   WHERE id = p_import_id
     AND company_id = p_company_id
     AND status = 'completed';

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Import % not found or not in completed status', p_import_id;
  END IF;

  IF v_fiscal_period_id IS NOT NULL THEN
    SELECT is_closed, locked_at
      INTO v_is_closed, v_locked_at
      FROM public.fiscal_periods
     WHERE id = v_fiscal_period_id;

    IF v_is_closed OR v_locked_at IS NOT NULL THEN
      RAISE EXCEPTION 'Cannot undo SIE import in a locked or closed fiscal period';
    END IF;
  END IF;

  PERFORM set_config('gnubok.allow_delete', 'true', true);

  -- Detach documents (entry- and line-level).
  UPDATE public.document_attachments
     SET journal_entry_id      = NULL,
         journal_entry_line_id = NULL
   WHERE journal_entry_id IN (
     SELECT je.id
       FROM public.journal_entries je
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       IN ('import', 'opening_balance')
        AND je.status            IN ('posted', 'cancelled')
   )
      OR journal_entry_line_id IN (
     SELECT jel.id
       FROM public.journal_entry_lines jel
       JOIN public.journal_entries je ON je.id = jel.journal_entry_id
      WHERE je.company_id        = p_company_id
        AND je.fiscal_period_id  = v_fiscal_period_id
        AND je.source_type       IN ('import', 'opening_balance')
        AND je.status            IN ('posted', 'cancelled')
   );

  -- Clear the fiscal-period OB pointer (two-step around
  -- enforce_opening_balance_immutability).
  IF v_opening_balance_entry_id IS NOT NULL THEN
    UPDATE public.fiscal_periods
       SET opening_balances_set = false
     WHERE id = v_fiscal_period_id
       AND opening_balance_entry_id = v_opening_balance_entry_id;

    UPDATE public.fiscal_periods
       SET opening_balance_entry_id = NULL
     WHERE id = v_fiscal_period_id
       AND opening_balance_entry_id = v_opening_balance_entry_id;
  END IF;

  -- Drop the sie_imports -> opening_balance_entry FK before delete.
  UPDATE public.sie_imports
     SET opening_balance_entry_id = NULL
   WHERE id = p_import_id;

  -- Hard-delete the import's journal entries (both transaction vouchers
  -- and the opening_balance entry).
  WITH deleted AS (
    DELETE FROM public.journal_entries
     WHERE company_id        = p_company_id
       AND fiscal_period_id  = v_fiscal_period_id
       AND source_type       IN ('import', 'opening_balance')
       AND status            IN ('posted', 'cancelled')
    RETURNING id
  )
  SELECT count(*) INTO v_deleted FROM deleted;

  -- Registry lockstep (dimensions plan PR5): remove dimension VALUES this
  -- import introduced, unless a remaining posted/reversed line still
  -- references the code (other imports, manual bookkeeping). User-created
  -- rows have created_by_import_id NULL and are never touched.
  DELETE FROM public.dimension_values dv
   USING public.dimensions d
   WHERE dv.created_by_import_id = p_import_id
     AND dv.company_id           = p_company_id
     AND d.id                    = dv.dimension_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.journal_entries je
         JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.company_id = p_company_id
          AND je.status IN ('posted', 'reversed')
          AND jel.dimensions ->> d.sie_dim_no::text = dv.code
     );

  -- ...and custom DIMENSIONS this import introduced that are now empty and
  -- unreferenced. System dims (1/6) are never import-created and are
  -- trigger-protected regardless.
  DELETE FROM public.dimensions d
   WHERE d.created_by_import_id = p_import_id
     AND d.company_id           = p_company_id
     AND d.is_system            = false
     AND NOT EXISTS (
       SELECT 1 FROM public.dimension_values dv WHERE dv.dimension_id = d.id
     )
     AND NOT EXISTS (
       SELECT 1
         FROM public.journal_entries je
         JOIN public.journal_entry_lines jel ON jel.journal_entry_id = je.id
        WHERE je.company_id = p_company_id
          AND je.status IN ('posted', 'reversed')
          AND jel.dimensions ? d.sie_dim_no::text
     );

  -- Reset voucher_sequences per series to the max remaining number.
  UPDATE public.voucher_sequences vs
     SET last_number = COALESCE((
           SELECT MAX(je.voucher_number)
             FROM public.journal_entries je
            WHERE je.company_id       = vs.company_id
              AND je.fiscal_period_id = vs.fiscal_period_id
              AND je.voucher_series   = vs.voucher_series
              AND je.voucher_number  > 0
         ), 0),
         updated_at = now()
   WHERE vs.company_id        = p_company_id
     AND vs.fiscal_period_id  = v_fiscal_period_id;

  UPDATE public.sie_imports
     SET status      = 'undone',
         replaced_at = now()
   WHERE id = p_import_id
     AND company_id = p_company_id;

  RETURN v_deleted;
END;
$function$;

NOTIFY pgrst, 'reload schema';
