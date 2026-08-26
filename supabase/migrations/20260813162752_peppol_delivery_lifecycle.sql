-- Provider-neutral Peppol delivery staging and audit foundation.
--
-- This migration deliberately does not implement network delivery. A certified
-- Access Point contract, participant onboarding, credentials, and verified
-- webhook contract are still required. The tables and RPCs preserve the exact
-- staged UBL document, a stable provider idempotency key, every verified event,
-- and retrieved evidence without equating Corner 3 transport with buyer
-- acceptance.

CREATE TABLE public.peppol_deliveries (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  invoice_id uuid NOT NULL REFERENCES public.invoices(id) ON DELETE RESTRICT,
  idempotency_key uuid NOT NULL DEFAULT uuid_generate_v4(),
  recipient_scheme text NOT NULL,
  recipient_identifier text NOT NULL,
  customization_id text NOT NULL,
  profile_id text NOT NULL,
  filename text NOT NULL,
  xml_payload text NOT NULL,
  xml_sha256 text NOT NULL,
  provider text,
  provider_tenant_id text,
  provider_submission_id text,
  status text NOT NULL DEFAULT 'staged',
  status_at timestamptz NOT NULL DEFAULT now(),
  status_detail text,
  submitted_at timestamptz,
  terminal_at timestamptz,
  evidence_retrieved_at timestamptz,
  retention_expires_at date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peppol_deliveries_recipient_scheme_format
    CHECK (recipient_scheme ~ '^[0-9]{4}$'),
  CONSTRAINT peppol_deliveries_recipient_identifier_format
    CHECK (recipient_identifier = btrim(recipient_identifier)
      AND length(recipient_identifier) BETWEEN 1 AND 128),
  CONSTRAINT peppol_deliveries_xml_sha256_format
    CHECK (xml_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peppol_deliveries_payload_present
    CHECK (length(xml_payload) > 0 AND length(filename) BETWEEN 1 AND 255),
  CONSTRAINT peppol_deliveries_provider_shape
    CHECK (
      (provider IS NULL AND provider_tenant_id IS NULL AND provider_submission_id IS NULL)
      OR (provider IS NOT NULL AND length(btrim(provider)) BETWEEN 1 AND 64)
    ),
  CONSTRAINT peppol_deliveries_status_check CHECK (status IN (
    'staged',
    'recipient_verified',
    'submitting',
    'retryable_failure',
    'submission_accepted',
    'transport_succeeded',
    'recipient_acknowledged',
    'business_accepted',
    'business_rejected',
    'no_route',
    'failed'
  )),
  CONSTRAINT peppol_deliveries_terminal_shape CHECK (
    terminal_at IS NULL
    OR status IN ('business_accepted', 'business_rejected', 'no_route', 'failed')
  ),
  CONSTRAINT peppol_deliveries_submission_shape CHECK (
    submitted_at IS NULL OR provider IS NOT NULL
  )
);

CREATE UNIQUE INDEX idx_peppol_deliveries_company_idempotency
  ON public.peppol_deliveries (company_id, idempotency_key);
CREATE UNIQUE INDEX idx_peppol_deliveries_staged_document
  ON public.peppol_deliveries (company_id, invoice_id, xml_sha256);
CREATE UNIQUE INDEX idx_peppol_deliveries_provider_submission
  ON public.peppol_deliveries (provider, provider_submission_id)
  WHERE provider IS NOT NULL AND provider_submission_id IS NOT NULL;
CREATE INDEX idx_peppol_deliveries_invoice_created
  ON public.peppol_deliveries (company_id, invoice_id, created_at DESC);

CREATE TABLE public.peppol_delivery_events (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL REFERENCES public.peppol_deliveries(id) ON DELETE RESTRICT,
  source text NOT NULL,
  provider text,
  provider_event_id text,
  provider_event_code text NOT NULL,
  normalized_status text NOT NULL,
  is_terminal boolean NOT NULL DEFAULT false,
  detail text,
  raw_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  event_sha256 text NOT NULL,
  verification_method text NOT NULL,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peppol_delivery_events_source_check
    CHECK (source IN ('local', 'provider')),
  CONSTRAINT peppol_delivery_events_status_check CHECK (normalized_status IN (
    'staged',
    'recipient_verified',
    'submitting',
    'retryable_failure',
    'submission_accepted',
    'transport_succeeded',
    'recipient_acknowledged',
    'business_accepted',
    'business_rejected',
    'no_route',
    'failed'
  )),
  CONSTRAINT peppol_delivery_events_terminal_status CHECK (
    NOT is_terminal
    OR normalized_status IN ('business_accepted', 'business_rejected', 'no_route', 'failed')
  ),
  CONSTRAINT peppol_delivery_events_raw_payload_object
    CHECK (jsonb_typeof(raw_payload) = 'object'),
  CONSTRAINT peppol_delivery_events_sha256_format
    CHECK (event_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peppol_delivery_events_verification_present
    CHECK (length(btrim(verification_method)) BETWEEN 1 AND 64),
  CONSTRAINT peppol_delivery_events_provider_shape CHECK (
    (source = 'local' AND provider IS NULL)
    OR (source = 'provider' AND provider IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_peppol_delivery_events_fingerprint
  ON public.peppol_delivery_events (delivery_id, event_sha256);
CREATE UNIQUE INDEX idx_peppol_delivery_events_provider_event
  ON public.peppol_delivery_events (provider, provider_event_id)
  WHERE provider IS NOT NULL AND provider_event_id IS NOT NULL;
CREATE INDEX idx_peppol_delivery_events_delivery_received
  ON public.peppol_delivery_events (delivery_id, received_at);

CREATE TABLE public.peppol_delivery_evidence (
  id uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE RESTRICT,
  delivery_id uuid NOT NULL REFERENCES public.peppol_deliveries(id) ON DELETE RESTRICT,
  provider text NOT NULL,
  evidence_type text NOT NULL,
  evidence_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_payload text,
  document_sha256 text,
  evidence_sha256 text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT peppol_delivery_evidence_provider_present
    CHECK (length(btrim(provider)) BETWEEN 1 AND 64),
  CONSTRAINT peppol_delivery_evidence_type_present
    CHECK (length(btrim(evidence_type)) BETWEEN 1 AND 128),
  CONSTRAINT peppol_delivery_evidence_payload_object
    CHECK (jsonb_typeof(evidence_payload) = 'object'),
  CONSTRAINT peppol_delivery_evidence_sha256_format
    CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peppol_delivery_evidence_document_sha256_format
    CHECK (document_sha256 IS NULL OR document_sha256 ~ '^[0-9a-f]{64}$'),
  CONSTRAINT peppol_delivery_evidence_document_shape CHECK (
    (document_payload IS NULL AND document_sha256 IS NULL)
    OR (document_payload IS NOT NULL AND document_sha256 IS NOT NULL)
  )
);

CREATE UNIQUE INDEX idx_peppol_delivery_evidence_fingerprint
  ON public.peppol_delivery_evidence (delivery_id, evidence_sha256);
CREATE INDEX idx_peppol_delivery_evidence_delivery_retrieved
  ON public.peppol_delivery_evidence (delivery_id, retrieved_at);

ALTER TABLE public.peppol_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.peppol_delivery_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.peppol_delivery_evidence ENABLE ROW LEVEL SECURITY;

-- Policies express tenant ownership, but direct table grants stay revoked so
-- the browser cannot read immutable XML, raw webhooks, or provider evidence.
-- User-facing reads go through the minimized summary RPC below.
CREATE POLICY "view own-company peppol deliveries"
  ON public.peppol_deliveries FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "view own-company peppol delivery events"
  ON public.peppol_delivery_events FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));
CREATE POLICY "view own-company peppol delivery evidence"
  ON public.peppol_delivery_evidence FOR SELECT
  USING (company_id IN (SELECT public.user_company_ids()));

REVOKE ALL ON public.peppol_deliveries FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.peppol_delivery_events FROM PUBLIC, anon, authenticated;
REVOKE ALL ON public.peppol_delivery_evidence FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.peppol_delivery_status_rank(p_status text)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_status
    WHEN 'staged' THEN 0
    WHEN 'recipient_verified' THEN 5
    WHEN 'submitting' THEN 10
    WHEN 'retryable_failure' THEN 15
    WHEN 'submission_accepted' THEN 20
    WHEN 'transport_succeeded' THEN 30
    WHEN 'recipient_acknowledged' THEN 40
    WHEN 'business_accepted' THEN 50
    WHEN 'business_rejected' THEN 50
    WHEN 'no_route' THEN 50
    WHEN 'failed' THEN 50
    ELSE -1
  END
$$;

REVOKE ALL ON FUNCTION public.peppol_delivery_status_rank(text)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.enforce_peppol_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
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

CREATE TRIGGER enforce_peppol_delivery_immutability
  BEFORE UPDATE OR DELETE ON public.peppol_deliveries
  FOR EACH ROW EXECUTE FUNCTION public.enforce_peppol_delivery_immutability();

CREATE OR REPLACE FUNCTION public.enforce_peppol_append_only()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  RAISE EXCEPTION 'Peppol audit records are append-only'
    USING ERRCODE = '23514';
END;
$$;

CREATE TRIGGER enforce_peppol_delivery_events_append_only
  BEFORE UPDATE OR DELETE ON public.peppol_delivery_events
  FOR EACH ROW EXECUTE FUNCTION public.enforce_peppol_append_only();
CREATE TRIGGER enforce_peppol_delivery_evidence_append_only
  BEFORE UPDATE OR DELETE ON public.peppol_delivery_evidence
  FOR EACH ROW EXECUTE FUNCTION public.enforce_peppol_append_only();

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
  invoice_owner uuid;
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

  SELECT invoice.invoice_date, invoice.user_id
  INTO invoice_date, invoice_owner
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

  SELECT * INTO staged
  FROM public.peppol_deliveries AS delivery
  WHERE delivery.company_id = p_company_id
    AND delivery.invoice_id = p_invoice_id
    AND delivery.xml_sha256 = p_xml_sha256;
  IF FOUND THEN
    RETURN staged;
  END IF;

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
  RETURNING * INTO staged;

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

REVOKE ALL ON FUNCTION public.stage_peppol_delivery(
  uuid, uuid, text, text, text, text, text, text, text
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.stage_peppol_delivery(
  uuid, uuid, text, text, text, text, text, text, text
) TO authenticated;

CREATE OR REPLACE FUNCTION public.record_peppol_delivery_event(
  p_company_id uuid,
  p_idempotency_key uuid,
  p_provider text,
  p_provider_tenant_id text,
  p_provider_submission_id text,
  p_provider_event_id text,
  p_provider_event_code text,
  p_normalized_status text,
  p_is_terminal boolean,
  p_detail text,
  p_raw_payload jsonb,
  p_event_sha256 text,
  p_verification_method text,
  p_occurred_at timestamptz
)
RETURNS public.peppol_deliveries
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target public.peppol_deliveries%ROWTYPE;
  inserted_count integer := 0;
  next_rank integer;
  current_rank integer;
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    AND COALESCE(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'role'
      IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'Peppol provider events require service role'
      USING ERRCODE = '42501';
  END IF;

  IF p_normalized_status NOT IN (
    'staged', 'recipient_verified', 'submitting', 'retryable_failure',
    'submission_accepted', 'transport_succeeded', 'recipient_acknowledged',
    'business_accepted', 'business_rejected', 'no_route', 'failed'
  ) THEN
    RAISE EXCEPTION 'unsupported normalized Peppol status'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO target
  FROM public.peppol_deliveries AS delivery
  WHERE delivery.company_id = p_company_id
    AND delivery.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Peppol delivery not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF target.provider IS NOT NULL AND target.provider IS DISTINCT FROM p_provider THEN
    RAISE EXCEPTION 'Peppol provider correlation mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF target.provider_tenant_id IS NOT NULL
    AND target.provider_tenant_id IS DISTINCT FROM p_provider_tenant_id
  THEN
    RAISE EXCEPTION 'Peppol provider tenant correlation mismatch'
      USING ERRCODE = '23514';
  END IF;
  IF target.provider_submission_id IS NOT NULL
    AND p_provider_submission_id IS NOT NULL
    AND target.provider_submission_id IS DISTINCT FROM p_provider_submission_id
  THEN
    RAISE EXCEPTION 'Peppol submission correlation mismatch'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.peppol_delivery_events (
    company_id, delivery_id, source, provider, provider_event_id,
    provider_event_code, normalized_status, is_terminal, detail, raw_payload,
    event_sha256, verification_method, occurred_at
  ) VALUES (
    p_company_id, target.id, 'provider', p_provider, p_provider_event_id,
    p_provider_event_code, p_normalized_status, p_is_terminal, p_detail,
    COALESCE(p_raw_payload, '{}'::jsonb), lower(p_event_sha256),
    p_verification_method, COALESCE(p_occurred_at, now())
  )
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS inserted_count = ROW_COUNT;

  IF inserted_count = 0 THEN
    RETURN target;
  END IF;

  next_rank := public.peppol_delivery_status_rank(p_normalized_status);
  current_rank := public.peppol_delivery_status_rank(target.status);

  PERFORM set_config('accounted.peppol_projection_update', '1', true);
  UPDATE public.peppol_deliveries AS delivery
  SET provider = COALESCE(delivery.provider, p_provider),
      provider_tenant_id = COALESCE(delivery.provider_tenant_id, p_provider_tenant_id),
      provider_submission_id = COALESCE(
        delivery.provider_submission_id,
        p_provider_submission_id
      ),
      status = CASE
        WHEN delivery.terminal_at IS NOT NULL THEN delivery.status
        WHEN next_rank > current_rank THEN p_normalized_status
        WHEN delivery.status = 'retryable_failure'
          AND p_normalized_status IN ('submitting', 'submission_accepted')
          THEN p_normalized_status
        WHEN next_rank = current_rank AND COALESCE(p_occurred_at, now()) > delivery.status_at
          THEN p_normalized_status
        ELSE delivery.status
      END,
      status_at = CASE
        WHEN delivery.terminal_at IS NOT NULL THEN delivery.status_at
        WHEN next_rank > current_rank
          OR (delivery.status = 'retryable_failure'
            AND p_normalized_status IN ('submitting', 'submission_accepted'))
          OR (next_rank = current_rank AND COALESCE(p_occurred_at, now()) > delivery.status_at)
          THEN COALESCE(p_occurred_at, now())
        ELSE delivery.status_at
      END,
      status_detail = CASE
        WHEN delivery.terminal_at IS NULL AND (
          next_rank > current_rank
          OR (delivery.status = 'retryable_failure'
            AND p_normalized_status IN ('submitting', 'submission_accepted'))
          OR (next_rank = current_rank AND COALESCE(p_occurred_at, now()) > delivery.status_at)
        ) THEN p_detail
        ELSE delivery.status_detail
      END,
      submitted_at = CASE
        WHEN p_normalized_status IN (
          'submission_accepted', 'transport_succeeded', 'recipient_acknowledged',
          'business_accepted', 'business_rejected'
        ) THEN COALESCE(delivery.submitted_at, COALESCE(p_occurred_at, now()))
        ELSE delivery.submitted_at
      END,
      terminal_at = CASE
        WHEN delivery.terminal_at IS NULL AND p_is_terminal
          THEN COALESCE(p_occurred_at, now())
        ELSE delivery.terminal_at
      END,
      updated_at = now()
  WHERE delivery.id = target.id
  RETURNING * INTO target;

  RETURN target;
END;
$$;

REVOKE ALL ON FUNCTION public.record_peppol_delivery_event(
  uuid, uuid, text, text, text, text, text, text, boolean, text, jsonb,
  text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_peppol_delivery_event(
  uuid, uuid, text, text, text, text, text, text, boolean, text, jsonb,
  text, text, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.record_peppol_delivery_evidence(
  p_company_id uuid,
  p_idempotency_key uuid,
  p_provider text,
  p_evidence_type text,
  p_evidence_payload jsonb,
  p_document_payload text,
  p_document_sha256 text,
  p_evidence_sha256 text,
  p_retrieved_at timestamptz
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target public.peppol_deliveries%ROWTYPE;
  evidence_id uuid;
BEGIN
  IF COALESCE(current_setting('request.jwt.claim.role', true), '') <> 'service_role'
    AND COALESCE(current_setting('request.jwt.claims', true), '{}')::jsonb ->> 'role'
      IS DISTINCT FROM 'service_role'
  THEN
    RAISE EXCEPTION 'Peppol evidence writes require service role'
      USING ERRCODE = '42501';
  END IF;

  SELECT * INTO target
  FROM public.peppol_deliveries AS delivery
  WHERE delivery.company_id = p_company_id
    AND delivery.idempotency_key = p_idempotency_key
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Peppol delivery not found'
      USING ERRCODE = 'P0002';
  END IF;
  IF target.provider IS DISTINCT FROM p_provider THEN
    RAISE EXCEPTION 'Peppol evidence provider correlation mismatch'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.peppol_delivery_evidence (
    company_id, delivery_id, provider, evidence_type, evidence_payload,
    document_payload, document_sha256, evidence_sha256, retrieved_at
  ) VALUES (
    p_company_id, target.id, p_provider, p_evidence_type,
    COALESCE(p_evidence_payload, '{}'::jsonb), p_document_payload,
    lower(p_document_sha256), lower(p_evidence_sha256),
    COALESCE(p_retrieved_at, now())
  )
  ON CONFLICT (delivery_id, evidence_sha256) DO NOTHING
  RETURNING id INTO evidence_id;

  IF evidence_id IS NULL THEN
    SELECT evidence.id INTO evidence_id
    FROM public.peppol_delivery_evidence AS evidence
    WHERE evidence.delivery_id = target.id
      AND evidence.evidence_sha256 = lower(p_evidence_sha256);
  END IF;

  PERFORM set_config('accounted.peppol_projection_update', '1', true);
  UPDATE public.peppol_deliveries
  SET evidence_retrieved_at = GREATEST(
        COALESCE(evidence_retrieved_at, '-infinity'::timestamptz),
        COALESCE(p_retrieved_at, now())
      ),
      updated_at = now()
  WHERE id = target.id;

  RETURN evidence_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_peppol_delivery_evidence(
  uuid, uuid, text, text, jsonb, text, text, text, timestamptz
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_peppol_delivery_evidence(
  uuid, uuid, text, text, jsonb, text, text, text, timestamptz
) TO service_role;

CREATE OR REPLACE FUNCTION public.list_peppol_delivery_summaries(
  p_company_id uuid,
  p_invoice_id uuid
)
RETURNS TABLE (
  id uuid,
  idempotency_key uuid,
  recipient_scheme text,
  recipient_identifier text,
  xml_sha256 text,
  provider text,
  provider_submission_id text,
  status text,
  status_at timestamptz,
  status_detail text,
  submitted_at timestamptz,
  terminal_at timestamptz,
  evidence_retrieved_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.company_members AS member
    WHERE member.company_id = p_company_id
      AND member.user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'not authorized to list Peppol delivery summaries'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    delivery.id,
    delivery.idempotency_key,
    delivery.recipient_scheme,
    delivery.recipient_identifier,
    delivery.xml_sha256,
    delivery.provider,
    delivery.provider_submission_id,
    delivery.status,
    delivery.status_at,
    delivery.status_detail,
    delivery.submitted_at,
    delivery.terminal_at,
    delivery.evidence_retrieved_at,
    delivery.created_at
  FROM public.peppol_deliveries AS delivery
  WHERE delivery.company_id = p_company_id
    AND delivery.invoice_id = p_invoice_id
  ORDER BY delivery.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_peppol_delivery_summaries(uuid, uuid)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.list_peppol_delivery_summaries(uuid, uuid)
  TO authenticated;

COMMENT ON TABLE public.peppol_deliveries IS
  'Immutable staged Peppol BIS Billing documents plus a projection of verified delivery events. Staged does not mean sent; transport_succeeded does not mean buyer acceptance.';
COMMENT ON TABLE public.peppol_delivery_events IS
  'Append-only normalized and raw verified Peppol provider events. All events remain evidence even when they arrive out of order and do not change the delivery projection.';
COMMENT ON TABLE public.peppol_delivery_evidence IS
  'Append-only Access Point evidence snapshots, optionally including the exact transmitted document returned by the provider.';
COMMENT ON COLUMN public.peppol_deliveries.idempotency_key IS
  'Stable caller-supplied key for a future provider submit call. Reused for retries of this exact staged XML.';
COMMENT ON COLUMN public.peppol_deliveries.xml_payload IS
  'Exact UBL XML staged for submission. Immutable and excluded from user-facing summary RPCs.';
COMMENT ON COLUMN public.peppol_deliveries.status IS
  'Latest monotonic normalized projection. Raw events remain authoritative audit evidence; transport_succeeded is only Corner 3 transport.';

NOTIFY pgrst, 'reload schema';
