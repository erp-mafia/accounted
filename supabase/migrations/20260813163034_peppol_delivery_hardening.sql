-- Hardening found by staging advisors and concurrency review.

CREATE INDEX idx_peppol_deliveries_invoice_id
  ON public.peppol_deliveries (invoice_id);
CREATE INDEX idx_peppol_deliveries_user_id
  ON public.peppol_deliveries (user_id);
CREATE INDEX idx_peppol_delivery_events_company_id
  ON public.peppol_delivery_events (company_id);
CREATE INDEX idx_peppol_delivery_evidence_company_id
  ON public.peppol_delivery_evidence (company_id);

DROP POLICY "view own-company peppol deliveries" ON public.peppol_deliveries;
CREATE POLICY "view own-company peppol deliveries"
  ON public.peppol_deliveries FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY "view own-company peppol delivery events" ON public.peppol_delivery_events;
CREATE POLICY "view own-company peppol delivery events"
  ON public.peppol_delivery_events FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

DROP POLICY "view own-company peppol delivery evidence" ON public.peppol_delivery_evidence;
CREATE POLICY "view own-company peppol delivery evidence"
  ON public.peppol_delivery_evidence FOR SELECT TO authenticated
  USING (company_id IN (SELECT public.user_company_ids()));

CREATE OR REPLACE FUNCTION public.enforce_peppol_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Peppol delivery records are retained and cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  IF current_setting('accounted.peppol_projection_update', true) IS DISTINCT FROM '1' THEN
    RAISE EXCEPTION 'Peppol delivery state may only change through its event RPC'
      USING ERRCODE = '42501';
  END IF;

  IF NEW.company_id IS DISTINCT FROM OLD.company_id
    OR NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.recipient_scheme IS DISTINCT FROM OLD.recipient_scheme
    OR NEW.recipient_identifier IS DISTINCT FROM OLD.recipient_identifier
    OR NEW.customization_id IS DISTINCT FROM OLD.customization_id
    OR NEW.profile_id IS DISTINCT FROM OLD.profile_id
    OR NEW.filename IS DISTINCT FROM OLD.filename
    OR NEW.xml_payload IS DISTINCT FROM OLD.xml_payload
    OR NEW.xml_sha256 IS DISTINCT FROM OLD.xml_sha256
    OR NEW.retention_expires_at IS DISTINCT FROM OLD.retention_expires_at
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
  THEN
    RAISE EXCEPTION 'Peppol staged document and tenant identity are immutable'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.provider IS NOT NULL AND NEW.provider IS DISTINCT FROM OLD.provider THEN
    RAISE EXCEPTION 'Peppol provider cannot change on an existing delivery'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_tenant_id IS NOT NULL
    AND NEW.provider_tenant_id IS DISTINCT FROM OLD.provider_tenant_id
  THEN
    RAISE EXCEPTION 'Peppol provider tenant cannot change on an existing delivery'
      USING ERRCODE = '23514';
  END IF;
  IF OLD.provider_submission_id IS NOT NULL
    AND NEW.provider_submission_id IS DISTINCT FROM OLD.provider_submission_id
  THEN
    RAISE EXCEPTION 'Peppol provider submission cannot change on an existing delivery'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.enforce_peppol_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Peppol audit records are append-only'
    USING ERRCODE = '23514';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_peppol_delivery_immutability()
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enforce_peppol_append_only()
  FROM PUBLIC, anon, authenticated;

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
  retention_basis date;
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

  SELECT period.period_end
  INTO retention_basis
  FROM public.fiscal_periods AS period
  WHERE period.company_id = p_company_id
    AND invoice_date BETWEEN period.period_start AND period.period_end
  ORDER BY period.period_end DESC
  LIMIT 1;
  retention_basis := COALESCE(retention_basis, invoice_date);

  INSERT INTO public.peppol_deliveries (
    company_id, user_id, invoice_id,
    recipient_scheme, recipient_identifier, customization_id, profile_id,
    filename, xml_payload, xml_sha256, retention_expires_at
  ) VALUES (
    p_company_id, actor_id, p_invoice_id,
    p_recipient_scheme, p_recipient_identifier, p_customization_id, p_profile_id,
    p_filename, p_xml_payload, lower(p_xml_sha256),
    (date_trunc('year', retention_basis)::date + interval '8 years')::date
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
