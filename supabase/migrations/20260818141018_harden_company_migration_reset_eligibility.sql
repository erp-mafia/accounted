-- Keep archive-and-replace resets before the first accounting record exists.
-- A replacement represents the same legal entity, so it must not start a
-- second voucher-number namespace after any draft, posting, or sequence state
-- has already been created on the retained source.

ALTER FUNCTION public.company_migration_reset_snapshot(uuid)
  RENAME TO company_migration_reset_snapshot_before_20260818141018;

CREATE OR REPLACE FUNCTION public.company_migration_reset_snapshot(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_snapshot               jsonb;
  v_blockers               jsonb;
  v_journal_entries        integer;
  v_voucher_sequences      integer;
  v_authority_submissions  integer;
  v_direct_vat_submissions integer;
BEGIN
  v_snapshot := public.company_migration_reset_snapshot_before_20260818141018(
    p_company_id
  );

  IF v_snapshot ->> 'code' = 'COMPANY_RESET_NOT_FOUND' THEN
    RETURN v_snapshot;
  END IF;

  SELECT count(*) INTO v_journal_entries
  FROM public.journal_entries
  WHERE company_id = p_company_id;

  SELECT count(*) INTO v_voucher_sequences
  FROM public.voucher_sequences
  WHERE company_id = p_company_id;

  SELECT COALESCE(sum((existing.blocker ->> 'count')::integer), 0)
  INTO v_authority_submissions
  FROM jsonb_array_elements(v_snapshot -> 'blockers') AS existing(blocker)
  WHERE existing.blocker ->> 'code' = 'authority_submission_detected';

  -- The VAT submission chain normally records a successful declaration lock
  -- first. Count the direct submission endpoint as independent evidence too,
  -- so a historical or interrupted audit chain still fails closed.
  SELECT count(*) INTO v_direct_vat_submissions
  FROM public.skatteverket_api_audit_log
  WHERE company_id = p_company_id
    AND outcome = 'ok'
    AND endpoint = 'declaration/submit';

  v_authority_submissions := v_authority_submissions + v_direct_vat_submissions;

  SELECT COALESCE(jsonb_agg(existing.blocker ORDER BY existing.position), '[]'::jsonb)
  INTO v_blockers
  FROM jsonb_array_elements(v_snapshot -> 'blockers')
    WITH ORDINALITY AS existing(blocker, position)
  WHERE existing.blocker ->> 'code' NOT IN (
    'non_import_committed_entries',
    'authority_submission_detected'
  );

  IF v_journal_entries > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'journal_entries_exist',
      'count', v_journal_entries
    ));
  END IF;

  IF v_voucher_sequences > 0 THEN
    v_blockers := v_blockers || jsonb_build_array(jsonb_build_object(
      'code', 'voucher_sequence_state_exists',
      'count', v_voucher_sequences
    ));
  END IF;

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
  'Internal fail-closed reset snapshot. Any journal entry or voucher sequence blocks archive-and-replace.';

REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot_before_20260818141018(uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.company_migration_reset_snapshot(uuid)
  FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
