-- A VAT draft locked for signing can be signed outside Accounted after the
-- lock succeeds. Historical direct-lock requests persisted their state in
-- extension_data but did not always create a Skatteverket audit row. Treat any
-- persisted VAT workflow state as authority interaction evidence: a saved
-- draft must be removed through the product before self-service reset, and a
-- locked state must never be cleared merely to make the company eligible.

ALTER FUNCTION public.company_migration_reset_snapshot(uuid)
  RENAME TO company_migration_reset_snapshot_before_20260818224000;

CREATE OR REPLACE FUNCTION public.company_migration_reset_snapshot(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot                  jsonb;
  v_blockers                  jsonb;
  v_authority_submissions     integer;
  v_unlogged_vat_workflows    integer;
BEGIN
  v_snapshot := public.company_migration_reset_snapshot_before_20260818224000(
    p_company_id
  );

  IF v_snapshot ->> 'code' = 'COMPANY_RESET_NOT_FOUND' THEN
    RETURN v_snapshot;
  END IF;

  SELECT COALESCE(sum((existing.blocker ->> 'count')::integer), 0)
  INTO v_authority_submissions
  FROM jsonb_array_elements(v_snapshot -> 'blockers') AS existing(blocker)
  WHERE existing.blocker ->> 'code' = 'authority_submission_detected';

  -- extension_data.value is a JSONB string for the Skatteverket extension,
  -- but the key itself is sufficient evidence that a VAT draft workflow was
  -- started. Avoid double-counting periods already represented by a successful
  -- lock/submit audit row while still failing closed for historical direct
  -- lock calls that predate complete audit coverage.
  SELECT count(*) INTO v_unlogged_vat_workflows
  FROM public.extension_data state
  WHERE state.company_id = p_company_id
    AND state.extension_id = 'skatteverket'
    AND state.key LIKE 'submission\_%' ESCAPE '\'
    AND NOT EXISTS (
      SELECT 1
      FROM public.skatteverket_api_audit_log audit
      WHERE audit.company_id = p_company_id
        AND audit.outcome = 'ok'
        AND audit.endpoint IN ('declaration/lock', 'declaration/submit')
        AND (
          audit.redovisningsperiod IS NULL
          OR audit.redovisningsperiod = substring(state.key FROM 12)
        )
    );

  v_authority_submissions :=
    v_authority_submissions + v_unlogged_vat_workflows;

  SELECT COALESCE(jsonb_agg(existing.blocker ORDER BY existing.position), '[]'::jsonb)
  INTO v_blockers
  FROM jsonb_array_elements(v_snapshot -> 'blockers')
    WITH ORDINALITY AS existing(blocker, position)
  WHERE existing.blocker ->> 'code' <> 'authority_submission_detected';

  IF v_authority_submissions > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'authority_submission_detected',
      'count', v_authority_submissions
    ));
  END IF;

  RETURN v_snapshot || jsonb_build_object(
    'eligible', jsonb_array_length(v_blockers) = 0,
    'blockers', v_blockers
  );
END;
$$;

COMMENT ON FUNCTION public.company_migration_reset_snapshot(uuid) IS
  'Internal fail-closed reset snapshot. VAT extension workflow state is authority interaction evidence.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_20260818224000(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

-- An eligible source has no VAT submission_* rows. This narrow guard closes
-- an in-flight or elevated insert after the source is archived without making
-- unrelated extension runtime state interfere with account anonymization.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_vat_state_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_company_id uuid;
  v_new_company_id uuid;
  v_old_is_vat_state boolean := false;
  v_new_is_vat_state boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_company_id := OLD.company_id;
    v_old_is_vat_state :=
      OLD.extension_id = 'skatteverket'
      AND OLD.key LIKE 'submission\_%' ESCAPE '\';
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_company_id := NEW.company_id;
    v_new_is_vat_state :=
      NEW.extension_id = 'skatteverket'
      AND NEW.key LIKE 'submission\_%' ESCAPE '\';
  END IF;

  IF (v_old_is_vat_state AND EXISTS (
        SELECT 1
        FROM public.company_migration_resets
        WHERE source_company_id = v_old_company_id
      ))
     OR (v_new_is_vat_state AND EXISTS (
        SELECT 1
        FROM public.company_migration_resets
        WHERE source_company_id = v_new_company_id
      )) THEN
    RAISE EXCEPTION 'Archived migration reset source VAT state is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER extension_data_block_migration_reset_source_vat_state
  BEFORE INSERT OR UPDATE OR DELETE ON public.extension_data
  FOR EACH ROW
  EXECUTE FUNCTION public.block_migration_reset_source_vat_state_mutation();

REVOKE ALL ON FUNCTION public.block_migration_reset_source_vat_state_mutation()
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
