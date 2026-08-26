-- Keep the legally corrected fiscal-period retention date as the single source
-- of truth for staged Peppol records. Missing periods remain a hard failure.

CREATE OR REPLACE FUNCTION public.stage_peppol_delivery(
  p_company_id uuid,
  p_invoice_id uuid,
  p_recipient_scheme text,
  p_recipient_identifier text,
  p_customization_id text,
  p_profile_id text,
  p_filename text,
  p_xml_payload text,
  p_xml_sha256 text
)
RETURNS public.peppol_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid := auth.uid();
  invoice_date date;
  retention_expiry date;
  staged public.peppol_deliveries%ROWTYPE;
BEGIN
  IF actor_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.company_members AS member
    WHERE member.company_id = p_company_id
      AND member.user_id = actor_id
      AND member.role <> 'viewer'
  ) THEN
    RAISE EXCEPTION 'not authorized to stage Peppol delivery'
      USING ERRCODE = '42501';
  END IF;

  SELECT invoice.invoice_date
  INTO invoice_date
  FROM public.invoices AS invoice
  WHERE invoice.id = p_invoice_id
    AND invoice.company_id = p_company_id
    AND invoice.invoice_number IS NOT NULL
    AND invoice.status <> 'cancelled';

  IF invoice_date IS NULL THEN
    RAISE EXCEPTION 'invoice not found or not eligible for Peppol staging'
      USING ERRCODE = 'P0002';
  END IF;

  SELECT period.retention_expires_at
  INTO retention_expiry
  FROM public.fiscal_periods AS period
  WHERE period.company_id = p_company_id
    AND invoice_date BETWEEN period.period_start AND period.period_end
  ORDER BY period.period_end DESC
  LIMIT 1;

  IF retention_expiry IS NULL THEN
    RAISE EXCEPTION 'Peppol delivery requires a fiscal period retention basis'
      USING ERRCODE = 'P0002';
  END IF;

  INSERT INTO public.peppol_deliveries (
    company_id, user_id, invoice_id,
    recipient_scheme, recipient_identifier, customization_id, profile_id,
    filename, xml_payload, xml_sha256, retention_expires_at
  ) VALUES (
    p_company_id, actor_id, p_invoice_id,
    p_recipient_scheme, p_recipient_identifier, p_customization_id, p_profile_id,
    p_filename, p_xml_payload, lower(p_xml_sha256), retention_expiry
  )
  ON CONFLICT (company_id, invoice_id, xml_sha256) DO NOTHING
  RETURNING * INTO staged;

  IF staged.id IS NULL THEN
    SELECT * INTO STRICT staged
    FROM public.peppol_deliveries AS delivery
    WHERE delivery.company_id = p_company_id
      AND delivery.invoice_id = p_invoice_id
      AND delivery.xml_sha256 = lower(p_xml_sha256);
    RETURN staged;
  END IF;

  INSERT INTO public.peppol_delivery_events (
    company_id, delivery_id, source, provider_event_code, normalized_status,
    raw_payload, event_sha256, verification_method, occurred_at
  ) VALUES (
    p_company_id, staged.id, 'local', 'staged', 'staged',
    jsonb_build_object(
      'invoice_id', p_invoice_id,
      'idempotency_key', staged.idempotency_key,
      'xml_sha256', staged.xml_sha256
    ),
    staged.xml_sha256,
    'local',
    staged.created_at
  );

  RETURN staged;
END;
$$;

NOTIFY pgrst, 'reload schema';
