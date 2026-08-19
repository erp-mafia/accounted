-- AGI uploads and ROT/RUT payout files cross the boundary into an external
-- signing flow before Accounted can observe a completed filing. The local
-- state can therefore lag behind Skatteverket. Treat every such staging state
-- as authority interaction evidence instead of assuming that a missing
-- receipt or a locally generated status proves the filing never happened.

ALTER FUNCTION public.company_migration_reset_snapshot(uuid)
  RENAME TO company_migration_reset_snapshot_before_20260818231500;

CREATE OR REPLACE FUNCTION public.company_migration_reset_snapshot(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot                    jsonb;
  v_blockers                    jsonb;
  v_authority_submissions       integer;
  v_external_staging_workflows  integer;
BEGIN
  v_snapshot := public.company_migration_reset_snapshot_before_20260818231500(
    p_company_id
  );

  IF v_snapshot ->> 'code' = 'COMPANY_RESET_NOT_FOUND' THEN
    RETURN v_snapshot;
  END IF;

  SELECT COALESCE(sum((existing.blocker ->> 'count')::integer), 0)
  INTO v_authority_submissions
  FROM jsonb_array_elements(v_snapshot -> 'blockers') AS existing(blocker)
  WHERE existing.blocker ->> 'code' = 'authority_submission_detected';

  -- An AGI underlag in Eget utrymme can be signed in Mina Sidor while the
  -- declaration still says pending_signature. The extension cache is also
  -- evidence because it is written before the declaration status update and
  -- can survive a partial application failure. Normalize the period so the
  -- declaration row and its cache count as one workflow.
  --
  -- A generated ROT/RUT payout file is returned for manual upload and signing.
  -- Accounted cannot prove that a locally generated or cancelled request was
  -- never submitted externally, so every request state is retention-protected.
  SELECT count(*)
  INTO v_external_staging_workflows
  FROM (
    SELECT
      'agi:' || declaration.period_year::text
        || lpad(declaration.period_month::text, 2, '0') AS workflow
    FROM public.agi_declarations declaration
    WHERE declaration.company_id = p_company_id
      AND declaration.status = 'pending_signature'

    UNION

    SELECT
      'agi:' || regexp_replace(
        substring(state.key FROM char_length('agi_submission_') + 1),
        '[^0-9]',
        '',
        'g'
      ) AS workflow
    FROM public.extension_data state
    WHERE state.company_id = p_company_id
      AND state.extension_id = 'skatteverket'
      AND state.key LIKE 'agi\_submission\_%' ESCAPE '\'
      AND NOT EXISTS (
        SELECT 1
        FROM public.agi_declarations declaration
        WHERE declaration.company_id = p_company_id
          AND declaration.period_year::text
                || lpad(declaration.period_month::text, 2, '0')
              = regexp_replace(
                  substring(state.key FROM char_length('agi_submission_') + 1),
                  '[^0-9]',
                  '',
                  'g'
                )
          AND (
            declaration.submitted_at IS NOT NULL
            OR declaration.status IN ('submitted', 'accepted', 'rejected')
          )
      )

    UNION

    SELECT 'rot_rut:' || request.id::text AS workflow
    FROM public.rot_rut_payout_requests request
    WHERE request.company_id = p_company_id
      AND NOT (
        request.submitted_at IS NOT NULL
        OR request.status IN ('submitted', 'paid', 'partially_paid', 'rejected')
      )
  ) staging;

  v_authority_submissions :=
    v_authority_submissions + v_external_staging_workflows;

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
  'Internal fail-closed reset snapshot. External filing staging state is authority interaction evidence.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_20260818231500(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

-- The retained source already rejects writes to agi_declarations and
-- rot_rut_payout_requests. Extend the narrow extension_data guard so an
-- in-flight or elevated writer cannot attach a new AGI upload state after the
-- company has been archived.
CREATE OR REPLACE FUNCTION public.block_migration_reset_source_vat_state_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_old_company_id uuid;
  v_new_company_id uuid;
  v_old_is_authority_state boolean := false;
  v_new_is_authority_state boolean := false;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    v_old_company_id := OLD.company_id;
    v_old_is_authority_state :=
      OLD.extension_id = 'skatteverket'
      AND (
        OLD.key LIKE 'submission\_%' ESCAPE '\'
        OR OLD.key LIKE 'agi\_submission\_%' ESCAPE '\'
      );
  END IF;

  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    v_new_company_id := NEW.company_id;
    v_new_is_authority_state :=
      NEW.extension_id = 'skatteverket'
      AND (
        NEW.key LIKE 'submission\_%' ESCAPE '\'
        OR NEW.key LIKE 'agi\_submission\_%' ESCAPE '\'
      );
  END IF;

  IF (v_old_is_authority_state AND EXISTS (
        SELECT 1
        FROM public.company_migration_resets
        WHERE source_company_id = v_old_company_id
      ))
     OR (v_new_is_authority_state AND EXISTS (
        SELECT 1
        FROM public.company_migration_resets
        WHERE source_company_id = v_new_company_id
      )) THEN
    RAISE EXCEPTION 'Archived migration reset source authority workflow state is immutable';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

ALTER TRIGGER extension_data_block_migration_reset_source_vat_state
  ON public.extension_data
  RENAME TO extension_data_block_migration_reset_source_authority_state;

COMMENT ON FUNCTION public.block_migration_reset_source_vat_state_mutation() IS
  'Rejects VAT and AGI authority workflow state on a retained migration reset source.';

REVOKE ALL ON FUNCTION public.block_migration_reset_source_vat_state_mutation()
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
