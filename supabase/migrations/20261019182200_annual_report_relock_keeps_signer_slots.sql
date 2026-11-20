-- Locking an unchanged årsredovisning again must not add signer slots (PH 186).
--
-- "Lås version för underskrift" on content that is already locked is
-- idempotent at the version level: create_annual_report_version finds the
-- content hash and returns the existing ready_for_signature version, and
-- create_annual_report_version_with_signatures then prepares its signature
-- slots again. prepare_annual_report_signature_slots, finding no unbound
-- roster to bind, copied the roster of the latest OTHER version with slots
-- onto it: a second pending slot for every signer of a version that already
-- had its own. The version only becomes signed when every bound slot is
-- signed (complete_annual_report_version_signing), so each signer then had
-- to be recorded twice, and the duplicate also showed in the signer list
-- and in the next version's signature page.
--
-- The copy is for a version that has no slots yet (the first lock after a
-- supersede or an owner reopen). This adds exactly that condition; nothing
-- else in the function changes. Existing duplicate slots are not touched
-- here (a one-shot repair, not a migration).

CREATE OR REPLACE FUNCTION public.prepare_annual_report_signature_slots(
  p_company_id uuid,
  p_fiscal_period_id uuid,
  p_annual_report_version_id uuid,
  p_user_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  bound_slot_count integer;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'Annual report signature user must match authenticated user'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.annual_report_versions
    WHERE id = p_annual_report_version_id
      AND company_id = p_company_id
      AND fiscal_period_id = p_fiscal_period_id
      AND status = 'ready_for_signature'
  ) THEN
    RAISE EXCEPTION 'Annual report version is not ready for signatures'
      USING ERRCODE = 'check_violation';
  END IF;

  UPDATE public.arsredovisning_signature_requests
  SET annual_report_version_id = p_annual_report_version_id
  WHERE company_id = p_company_id
    AND fiscal_period_id = p_fiscal_period_id
    AND status = 'pending'
    AND annual_report_version_id IS NULL;
  GET DIAGNOSTICS bound_slot_count = ROW_COUNT;

  -- A version that already has its slots (a repeated lock of the same
  -- content) keeps them: copying the previous roster again duplicates them.
  IF bound_slot_count = 0 AND NOT EXISTS (
    SELECT 1
    FROM public.arsredovisning_signature_requests existing
    WHERE existing.annual_report_version_id = p_annual_report_version_id
  ) THEN
    INSERT INTO public.arsredovisning_signature_requests (
      user_id,
      company_id,
      fiscal_period_id,
      annual_report_version_id,
      role,
      signer_name,
      status
    )
    SELECT
      p_user_id,
      p_company_id,
      p_fiscal_period_id,
      p_annual_report_version_id,
      roster.role,
      roster.signer_name,
      'pending'
    FROM (
      SELECT DISTINCT ON (lower(trim(request.role)), lower(trim(request.signer_name)))
        request.role,
        request.signer_name
      FROM public.arsredovisning_signature_requests request
      JOIN public.annual_report_versions prior_version
        ON prior_version.id = request.annual_report_version_id
      WHERE prior_version.company_id = p_company_id
        AND prior_version.fiscal_period_id = p_fiscal_period_id
        AND prior_version.id <> p_annual_report_version_id
        AND prior_version.version_number = (
          SELECT max(candidate.version_number)
          FROM public.annual_report_versions candidate
          WHERE candidate.company_id = p_company_id
            AND candidate.fiscal_period_id = p_fiscal_period_id
            AND candidate.id <> p_annual_report_version_id
            AND EXISTS (
              SELECT 1
              FROM public.arsredovisning_signature_requests candidate_request
              WHERE candidate_request.annual_report_version_id = candidate.id
            )
        )
      ORDER BY
        lower(trim(request.role)),
        lower(trim(request.signer_name)),
        request.created_at DESC
    ) AS roster;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.prepare_annual_report_signature_slots(uuid, uuid, uuid, uuid) IS
  'Binds the unbound pending signer roster to a ready_for_signature version; when there is none and the version has no slots yet, copies the roster of the latest earlier version with slots. A repeated lock of the same content leaves the version''s slots as they are. Service role only.';
