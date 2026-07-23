-- Keep exact invoice email payloads visible only to the sending user.
-- Other company members consume a data-minimized SECURITY DEFINER summary.

DROP POLICY IF EXISTS invoice_deliveries_select ON public.invoice_deliveries;

CREATE POLICY invoice_deliveries_select
  ON public.invoice_deliveries FOR SELECT TO authenticated
  USING (
    company_id = public.current_active_company_id()
    AND user_id = auth.uid()
  );

CREATE OR REPLACE FUNCTION public.list_invoice_delivery_summaries(
  p_company_id uuid,
  p_invoice_id uuid
)
RETURNS TABLE (
  id uuid,
  channel text,
  status text,
  to_addresses text[],
  cc_addresses text[],
  provider text,
  error_code text,
  document_attachment_id uuid,
  sent_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.uid() IS NULL
    OR p_company_id IS DISTINCT FROM public.current_active_company_id()
    OR NOT EXISTS (
      SELECT 1
      FROM public.company_members cm
      WHERE cm.company_id = p_company_id
        AND cm.user_id = auth.uid()
    )
  THEN
    RAISE EXCEPTION 'not authorized to list invoice delivery summaries'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    d.id,
    d.channel,
    d.status,
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(d.to_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(d.cc_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    d.provider,
    d.error_code,
    d.document_attachment_id,
    d.sent_at,
    d.failed_at,
    d.created_at
  FROM public.invoice_deliveries d
  WHERE d.company_id = p_company_id
    AND d.invoice_id = p_invoice_id
    AND d.status <> 'preparing'
  ORDER BY d.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) IS
  'Returns active-company invoice delivery status with masked To and CC addresses. Exact payload and BCC remain server-side.';

-- Fixed CC and BCC settings can redirect every future invoice email. Keep
-- these fields owner/admin controlled even when PostgREST is called directly.
CREATE OR REPLACE FUNCTION public.enforce_invoice_email_recipient_settings_admin()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND NEW.invoice_email_cc_addresses IS NOT DISTINCT FROM OLD.invoice_email_cc_addresses
    AND NEW.invoice_email_bcc_addresses IS NOT DISTINCT FROM OLD.invoice_email_bcc_addresses
  THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT'
    AND NEW.invoice_email_cc_addresses IS NULL
    AND NEW.invoice_email_bcc_addresses IS NULL
  THEN
    RETURN NEW;
  END IF;

  IF auth.role() = 'service_role' OR auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = NEW.company_id
      AND cm.user_id = auth.uid()
      AND cm.role IN ('owner', 'admin')
  ) THEN
    RAISE EXCEPTION 'owner or admin role required to change invoice email recipients'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_invoice_email_recipient_settings_admin
  ON public.company_settings;
CREATE TRIGGER enforce_invoice_email_recipient_settings_admin
  BEFORE INSERT OR UPDATE OF invoice_email_cc_addresses, invoice_email_bcc_addresses
  ON public.company_settings
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_invoice_email_recipient_settings_admin();

-- Direct authenticated delivery writes can forge evidence. All delivery state
-- changes now go through service-role-only RPCs that bind the row to a verified
-- company member supplied by the server route.
DROP POLICY IF EXISTS invoice_deliveries_insert ON public.invoice_deliveries;
DROP POLICY IF EXISTS invoice_deliveries_update ON public.invoice_deliveries;

CREATE OR REPLACE FUNCTION public.authorize_invoice_delivery_service_actor(
  p_company_id uuid,
  p_actor_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'invoice delivery writes require a server-controlled service role'
      USING ERRCODE = '42501';
  END IF;

  IF p_actor_user_id IS NULL OR NOT EXISTS (
    SELECT 1
    FROM public.company_members cm
    WHERE cm.company_id = p_company_id
      AND cm.user_id = p_actor_user_id
      AND cm.role IN ('owner', 'admin', 'member')
  ) THEN
    RAISE EXCEPTION 'invoice delivery actor is not a writable company member'
      USING ERRCODE = '42501';
  END IF;

  RETURN p_actor_user_id;
END;
$$;

REVOKE ALL ON FUNCTION public.authorize_invoice_delivery_service_actor(uuid, uuid)
  FROM PUBLIC, anon, authenticated;

-- A preparing row contains no recipient or message payload. It may be removed
-- after a bounded timeout so another authorized sender can recover from a
-- crashed render without deleting accounting evidence.
CREATE OR REPLACE FUNCTION public.enforce_invoice_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.status = 'preparing'
      AND OLD.created_at <= now() - interval '15 minutes'
    THEN
      RETURN OLD;
    END IF;

    INSERT INTO public.audit_log (
      user_id,
      company_id,
      action,
      table_name,
      record_id,
      actor_id,
      old_state,
      description
    ) VALUES (
      OLD.user_id,
      OLD.company_id,
      'SECURITY_EVENT',
      'invoice_deliveries',
      OLD.id,
      auth.uid(),
      public.invoice_delivery_audit_state(OLD),
      'Blocked deletion of immutable invoice delivery history.'
    );
    RETURN NULL;
  END IF;

  IF OLD.status = 'preparing' THEN
    IF NEW.status <> 'pending'
      OR NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.channel IS DISTINCT FROM OLD.channel
      OR NEW.provider IS NOT NULL
      OR NEW.provider_message_id IS NOT NULL
      OR NEW.error_code IS NOT NULL
      OR NEW.sent_at IS NOT NULL
      OR NEW.failed_at IS NOT NULL
      OR NEW.retention_expires_at IS DISTINCT FROM OLD.retention_expires_at
      OR NEW.pii_redacted_at IS NOT NULL
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
    THEN
      RAISE EXCEPTION 'preparing invoice delivery may only capture its pending payload'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'pending' THEN
    IF NEW.status NOT IN ('sent', 'failed') THEN
      RAISE EXCEPTION 'pending invoice delivery may only transition to sent or failed'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.company_id IS DISTINCT FROM OLD.company_id
      OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.invoice_id IS DISTINCT FROM OLD.invoice_id
      OR NEW.channel IS DISTINCT FROM OLD.channel
      OR NEW.to_addresses IS DISTINCT FROM OLD.to_addresses
      OR NEW.cc_addresses IS DISTINCT FROM OLD.cc_addresses
      OR NEW.bcc_addresses IS DISTINCT FROM OLD.bcc_addresses
      OR NEW.reply_to IS DISTINCT FROM OLD.reply_to
      OR NEW.from_name IS DISTINCT FROM OLD.from_name
      OR NEW.subject IS DISTINCT FROM OLD.subject
      OR NEW.body_text IS DISTINCT FROM OLD.body_text
      OR NEW.body_html IS DISTINCT FROM OLD.body_html
      OR NEW.attachment_filename IS DISTINCT FROM OLD.attachment_filename
      OR NEW.attachment_content_type IS DISTINCT FROM OLD.attachment_content_type
      OR NEW.attachment_sha256 IS DISTINCT FROM OLD.attachment_sha256
      OR NEW.retention_expires_at IS DISTINCT FROM OLD.retention_expires_at
      OR NEW.pii_redacted_at IS DISTINCT FROM OLD.pii_redacted_at
      OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR (
        NEW.status = 'sent'
        AND NEW.document_attachment_id IS DISTINCT FROM OLD.document_attachment_id
      )
      OR (
        NEW.status = 'failed'
        AND NEW.document_attachment_id IS NOT NULL
      )
    THEN
      RAISE EXCEPTION 'invoice delivery payload is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status IN ('sent', 'failed')
    AND OLD.pii_redacted_at IS NULL
    AND CURRENT_DATE >= OLD.retention_expires_at
    AND NEW.pii_redacted_at IS NOT NULL
    AND NEW.company_id IS NOT DISTINCT FROM OLD.company_id
    AND NEW.user_id IS NOT DISTINCT FROM OLD.user_id
    AND NEW.invoice_id IS NOT DISTINCT FROM OLD.invoice_id
    AND NEW.channel IS NOT DISTINCT FROM OLD.channel
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND cardinality(NEW.to_addresses) = 0
    AND cardinality(NEW.cc_addresses) = 0
    AND cardinality(NEW.bcc_addresses) = 0
    AND NEW.reply_to IS NULL
    AND NEW.from_name IS NULL
    AND NEW.subject IS NULL
    AND NEW.body_text IS NULL
    AND NEW.body_html IS NULL
    AND NEW.provider IS NOT DISTINCT FROM OLD.provider
    AND NEW.provider_message_id IS NULL
    AND NEW.error_code IS NOT DISTINCT FROM OLD.error_code
    AND NEW.document_attachment_id IS NOT DISTINCT FROM OLD.document_attachment_id
    AND NEW.attachment_filename IS NULL
    AND NEW.attachment_content_type IS NOT DISTINCT FROM OLD.attachment_content_type
    AND NEW.attachment_sha256 IS NULL
    AND NEW.sent_at IS NOT DISTINCT FROM OLD.sent_at
    AND NEW.failed_at IS NOT DISTINCT FROM OLD.failed_at
    AND NEW.retention_expires_at IS NOT DISTINCT FROM OLD.retention_expires_at
    AND NEW.created_at IS NOT DISTINCT FROM OLD.created_at
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'terminal invoice delivery (%) is immutable', OLD.status
    USING ERRCODE = '23514';
END;
$$;

CREATE OR REPLACE FUNCTION public.reserve_invoice_delivery(
  p_company_id uuid,
  p_invoice_id uuid,
  p_actor_user_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid;
  delivery_id uuid;
  existing_actor_id uuid;
  existing_created_at timestamptz;
BEGIN
  actor_id := public.authorize_invoice_delivery_service_actor(
    p_company_id,
    p_actor_user_id
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = p_invoice_id AND i.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'invoice not found for delivery reservation'
      USING ERRCODE = 'P0002';
  END IF;

  LOOP
    BEGIN
      INSERT INTO public.invoice_deliveries (
        company_id, user_id, invoice_id, channel, status
      ) VALUES (
        p_company_id, actor_id, p_invoice_id, 'email', 'preparing'
      )
      RETURNING id INTO delivery_id;
      RETURN delivery_id;
    EXCEPTION WHEN unique_violation THEN
      SELECT d.id, d.user_id, d.created_at
        INTO delivery_id, existing_actor_id, existing_created_at
      FROM public.invoice_deliveries d
      WHERE d.company_id = p_company_id
        AND d.invoice_id = p_invoice_id
        AND d.status = 'preparing'
      FOR UPDATE;

      IF delivery_id IS NULL THEN
        CONTINUE;
      END IF;
      IF existing_actor_id = actor_id THEN
        RETURN delivery_id;
      END IF;
      IF existing_created_at > now() - interval '15 minutes' THEN
        RAISE EXCEPTION 'invoice delivery is already being prepared'
          USING ERRCODE = '55P03';
      END IF;

      DELETE FROM public.invoice_deliveries d WHERE d.id = delivery_id;
      delivery_id := NULL;
    END;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.capture_invoice_delivery_payload(
  p_delivery_id uuid,
  p_company_id uuid,
  p_invoice_id uuid,
  p_actor_user_id uuid,
  p_to_addresses text[],
  p_cc_addresses text[],
  p_bcc_addresses text[],
  p_reply_to text,
  p_from_name text,
  p_subject text,
  p_body_text text,
  p_body_html text,
  p_document_attachment_id uuid,
  p_attachment_filename text,
  p_attachment_content_type text,
  p_attachment_sha256 text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid;
  captured_id uuid;
BEGIN
  actor_id := public.authorize_invoice_delivery_service_actor(
    p_company_id,
    p_actor_user_id
  );

  UPDATE public.invoice_deliveries
  SET status = 'pending',
      to_addresses = p_to_addresses,
      cc_addresses = p_cc_addresses,
      bcc_addresses = p_bcc_addresses,
      reply_to = p_reply_to,
      from_name = p_from_name,
      subject = p_subject,
      body_text = p_body_text,
      body_html = p_body_html,
      document_attachment_id = p_document_attachment_id,
      attachment_filename = p_attachment_filename,
      attachment_content_type = p_attachment_content_type,
      attachment_sha256 = p_attachment_sha256
  WHERE id = p_delivery_id
    AND company_id = p_company_id
    AND invoice_id = p_invoice_id
    AND user_id = actor_id
    AND status = 'preparing'
  RETURNING id INTO captured_id;

  IF captured_id IS NULL THEN
    RAISE EXCEPTION 'invoice delivery reservation cannot capture payload'
      USING ERRCODE = '23514';
  END IF;
  RETURN captured_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.finalize_invoice_delivery(
  p_delivery_id uuid,
  p_company_id uuid,
  p_actor_user_id uuid,
  p_status text,
  p_provider text,
  p_provider_message_id text,
  p_error_code text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid;
  finalized_id uuid;
BEGIN
  actor_id := public.authorize_invoice_delivery_service_actor(
    p_company_id,
    p_actor_user_id
  );

  IF p_status = 'sent' THEN
    UPDATE public.invoice_deliveries
    SET status = 'sent',
        provider = p_provider,
        provider_message_id = p_provider_message_id,
        error_code = NULL,
        sent_at = now(),
        failed_at = NULL
    WHERE id = p_delivery_id
      AND company_id = p_company_id
      AND user_id = actor_id
      AND status = 'pending'
    RETURNING id INTO finalized_id;
  ELSIF p_status = 'failed' THEN
    UPDATE public.invoice_deliveries
    SET status = 'failed',
        provider = p_provider,
        provider_message_id = NULL,
        error_code = COALESCE(p_error_code, 'provider_failed'),
        document_attachment_id = NULL,
        sent_at = NULL,
        failed_at = now()
    WHERE id = p_delivery_id
      AND company_id = p_company_id
      AND user_id = actor_id
      AND status = 'pending'
    RETURNING id INTO finalized_id;
  ELSE
    RAISE EXCEPTION 'invoice delivery terminal status must be sent or failed'
      USING ERRCODE = '22023';
  END IF;

  IF finalized_id IS NULL THEN
    RAISE EXCEPTION 'invoice delivery cannot be finalized'
      USING ERRCODE = '23514';
  END IF;
  RETURN finalized_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_manual_invoice_delivery(
  p_company_id uuid,
  p_invoice_id uuid,
  p_actor_user_id uuid,
  p_sent_at timestamptz DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  actor_id uuid;
  delivery public.invoice_deliveries%ROWTYPE;
BEGIN
  actor_id := public.authorize_invoice_delivery_service_actor(
    p_company_id,
    p_actor_user_id
  );

  IF NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = p_invoice_id
      AND i.company_id = p_company_id
      AND i.status IN ('sent', 'overdue', 'partially_paid', 'paid', 'credited')
  ) THEN
    RAISE EXCEPTION 'invoice is not in a manually sent state'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.invoice_deliveries (
    company_id, user_id, invoice_id, channel, status, sent_at
  ) VALUES (
    p_company_id, actor_id, p_invoice_id, 'manual', 'marked_sent',
    COALESCE(p_sent_at, now())
  )
  RETURNING * INTO delivery;

  RETURN to_jsonb(delivery);
END;
$$;

-- Deferred booking needs only the archived document id, not the email payload.
CREATE OR REPLACE FUNCTION public.latest_sent_invoice_delivery_document(
  p_company_id uuid,
  p_invoice_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  document_id uuid;
BEGIN
  IF auth.uid() IS NULL
    OR p_company_id IS DISTINCT FROM public.current_active_company_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = p_company_id AND cm.user_id = auth.uid()
    )
  THEN
    RAISE EXCEPTION 'not authorized to find delivered invoice document'
      USING ERRCODE = '42501';
  END IF;

  SELECT d.document_attachment_id
    INTO document_id
  FROM public.invoice_deliveries d
  WHERE d.company_id = p_company_id
    AND d.invoice_id = p_invoice_id
    AND d.status = 'sent'
    AND d.document_attachment_id IS NOT NULL
  ORDER BY d.sent_at DESC
  LIMIT 1;

  RETURN document_id;
END;
$$;

-- Full statutory exports are an explicit need-to-know exception to routine
-- sender-only payload access. Authenticated callers must be owner/admin; server
-- service paths are already authorized before invoking the exporter.
CREATE OR REPLACE FUNCTION public.export_invoice_delivery_evidence(
  p_company_id uuid
)
RETURNS SETOF public.invoice_deliveries
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' AND (
    auth.uid() IS NULL
    OR p_company_id IS DISTINCT FROM public.current_active_company_id()
    OR NOT EXISTS (
      SELECT 1 FROM public.company_members cm
      WHERE cm.company_id = p_company_id
        AND cm.user_id = auth.uid()
        AND cm.role IN ('owner', 'admin')
    )
  ) THEN
    RAISE EXCEPTION 'owner or admin role required to export invoice delivery evidence'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT d.*
  FROM public.invoice_deliveries d
  WHERE d.company_id = p_company_id;
END;
$$;

REVOKE ALL ON FUNCTION public.reserve_invoice_delivery(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.capture_invoice_delivery_payload(
  uuid, uuid, uuid, uuid, text[], text[], text[], text, text, text, text, text,
  uuid, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finalize_invoice_delivery(
  uuid, uuid, uuid, text, text, text, text
) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_manual_invoice_delivery(uuid, uuid, uuid, timestamptz)
  FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.reserve_invoice_delivery(uuid, uuid, uuid)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.capture_invoice_delivery_payload(
  uuid, uuid, uuid, uuid, text[], text[], text[], text, text, text, text, text,
  uuid, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.finalize_invoice_delivery(
  uuid, uuid, uuid, text, text, text, text
) TO service_role;
GRANT EXECUTE ON FUNCTION public.record_manual_invoice_delivery(uuid, uuid, uuid, timestamptz)
  TO service_role;

REVOKE ALL ON FUNCTION public.latest_sent_invoice_delivery_document(uuid, uuid)
  FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.latest_sent_invoice_delivery_document(uuid, uuid)
  TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.export_invoice_delivery_evidence(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.export_invoice_delivery_evidence(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.reserve_invoice_delivery(uuid, uuid, uuid) IS
  'Service-only reservation for an invoice email delivery. Reclaims payload-free reservations after 15 minutes.';
COMMENT ON FUNCTION public.latest_sent_invoice_delivery_document(uuid, uuid) IS
  'Returns only the latest sent delivery document id for active-company deferred booking.';
COMMENT ON FUNCTION public.export_invoice_delivery_evidence(uuid) IS
  'Returns exact company delivery evidence only to owner/admin audit exports and service-role server paths.';

NOTIFY pgrst, 'reload schema';
