-- Add configurable invoice email copies and retain the exact BCC delivery payload.

ALTER TABLE public.company_settings
  ADD COLUMN invoice_email_cc_addresses text[],
  ADD COLUMN invoice_email_bcc_addresses text[],
  ADD CONSTRAINT company_settings_invoice_email_cc_limit
    CHECK (invoice_email_cc_addresses IS NULL OR cardinality(invoice_email_cc_addresses) <= 20),
  ADD CONSTRAINT company_settings_invoice_email_bcc_limit
    CHECK (invoice_email_bcc_addresses IS NULL OR cardinality(invoice_email_bcc_addresses) <= 20);

ALTER TABLE public.invoice_deliveries
  ADD COLUMN bcc_addresses text[] NOT NULL DEFAULT '{}';

ALTER TABLE public.invoice_deliveries
  DROP CONSTRAINT invoice_deliveries_payload_shape,
  ADD CONSTRAINT invoice_deliveries_payload_shape CHECK (
    (
      channel = 'email'
      AND status = 'preparing'
      AND cardinality(to_addresses) = 0
      AND cardinality(cc_addresses) = 0
      AND cardinality(bcc_addresses) = 0
      AND reply_to IS NULL
      AND from_name IS NULL
      AND subject IS NULL
      AND body_text IS NULL
      AND body_html IS NULL
      AND provider IS NULL
      AND provider_message_id IS NULL
      AND error_code IS NULL
      AND document_attachment_id IS NULL
      AND attachment_filename IS NULL
      AND attachment_content_type IS NULL
      AND attachment_sha256 IS NULL
      AND pii_redacted_at IS NULL
    )
    OR
    (
      channel = 'email'
      AND status IN ('pending', 'sent', 'failed')
      AND pii_redacted_at IS NULL
      AND cardinality(to_addresses) > 0
      AND subject IS NOT NULL
      AND body_text IS NOT NULL
      AND body_html IS NOT NULL
      AND attachment_filename IS NOT NULL
      AND attachment_content_type IS NOT NULL
      AND attachment_sha256 IS NOT NULL
      AND (
        (status IN ('pending', 'sent') AND document_attachment_id IS NOT NULL)
        OR status = 'failed'
      )
    )
    OR
    (
      channel = 'email'
      AND status IN ('sent', 'failed')
      AND pii_redacted_at IS NOT NULL
      AND cardinality(to_addresses) = 0
      AND cardinality(cc_addresses) = 0
      AND cardinality(bcc_addresses) = 0
      AND reply_to IS NULL
      AND from_name IS NULL
      AND subject IS NULL
      AND body_text IS NULL
      AND body_html IS NULL
      AND provider_message_id IS NULL
      AND attachment_filename IS NULL
      AND attachment_sha256 IS NULL
    )
    OR
    (
      channel = 'manual'
      AND status = 'marked_sent'
      AND cardinality(to_addresses) = 0
      AND cardinality(cc_addresses) = 0
      AND cardinality(bcc_addresses) = 0
      AND reply_to IS NULL
      AND from_name IS NULL
      AND subject IS NULL
      AND body_text IS NULL
      AND body_html IS NULL
      AND provider IS NULL
      AND provider_message_id IS NULL
      AND error_code IS NULL
      AND document_attachment_id IS NULL
      AND attachment_filename IS NULL
      AND attachment_content_type IS NULL
      AND attachment_sha256 IS NULL
      AND pii_redacted_at IS NULL
    )
  );

CREATE OR REPLACE FUNCTION public.enforce_invoice_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
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

CREATE OR REPLACE FUNCTION public.redact_expired_invoice_delivery_pii()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  redacted_count integer;
BEGIN
  UPDATE public.invoice_deliveries
  SET to_addresses = '{}',
      cc_addresses = '{}',
      bcc_addresses = '{}',
      reply_to = NULL,
      from_name = NULL,
      subject = NULL,
      body_text = NULL,
      body_html = NULL,
      provider_message_id = NULL,
      attachment_filename = NULL,
      attachment_sha256 = NULL,
      pii_redacted_at = now()
  WHERE channel = 'email'
    AND status IN ('sent', 'failed')
    AND pii_redacted_at IS NULL
    AND retention_expires_at <= CURRENT_DATE;

  GET DIAGNOSTICS redacted_count = ROW_COUNT;
  RETURN redacted_count;
END;
$$;

COMMENT ON COLUMN public.company_settings.invoice_email_cc_addresses IS
  'Fixed CC recipients for invoice emails. NULL keeps the historical company-email fallback; an empty array disables it.';
COMMENT ON COLUMN public.company_settings.invoice_email_bcc_addresses IS
  'Fixed BCC recipients for invoice emails.';
COMMENT ON COLUMN public.invoice_deliveries.bcc_addresses IS
  'Exact BCC recipients submitted to the email provider. Redacted after the statutory retention period.';

NOTIFY pgrst, 'reload schema';
