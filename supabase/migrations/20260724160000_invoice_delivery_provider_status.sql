-- Provider delivery outcome for customer invoice emails.
--
-- Until now a delivery row stopped at 'sent', which only means the email
-- provider accepted the message. Whether the receiving server took it,
-- rejected it, or deferred it stayed invisible, so a bounced invoice still
-- looked green in the delivery history.
--
-- Resend reports the outcome per message (never per recipient), so the state
-- lives on the delivery row itself: one provider status, when it was observed,
-- and the provider's own reason text for the failure cases.
--
-- The row stays WORM: exactly these three columns may change after a send,
-- and only while the row has not been redacted.

ALTER TABLE public.invoice_deliveries
  ADD COLUMN provider_status        text,
  ADD COLUMN provider_status_at     timestamptz,
  ADD COLUMN provider_status_detail text;

ALTER TABLE public.invoice_deliveries
  ADD CONSTRAINT invoice_deliveries_provider_status_shape CHECK (
    (
      provider_status IS NULL
      AND provider_status_at IS NULL
      AND provider_status_detail IS NULL
    )
    OR (
      provider_status IN (
        'delayed', 'delivered', 'complained', 'bounced', 'failed', 'suppressed'
      )
      AND provider_status_at IS NOT NULL
      AND channel = 'email'
      AND status = 'sent'
    )
  );

COMMENT ON COLUMN public.invoice_deliveries.provider_status IS
  'Latest delivery outcome reported by the email provider for the whole message. NULL means no report received yet: accepted by the provider, nothing more.';
COMMENT ON COLUMN public.invoice_deliveries.provider_status_at IS
  'Provider timestamp for the reported outcome, not the time the report was ingested.';
COMMENT ON COLUMN public.invoice_deliveries.provider_status_detail IS
  'Provider reason text for a failed outcome. May name the failing recipient, so it is redacted with the rest of the delivery PII and masked before it leaves the server.';

-- Ranking makes out-of-order webhooks safe: a late "delayed" can never
-- overwrite an observed bounce. Equal ranks fall back to the provider clock.
CREATE OR REPLACE FUNCTION public.invoice_delivery_provider_status_rank(
  p_status text
)
RETURNS integer
LANGUAGE sql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
  SELECT CASE p_status
    WHEN 'delayed'    THEN 1
    WHEN 'delivered'  THEN 2
    WHEN 'complained' THEN 3
    WHEN 'bounced'    THEN 4
    WHEN 'failed'     THEN 4
    WHEN 'suppressed' THEN 4
    ELSE 0
  END
$$;

COMMENT ON FUNCTION public.invoice_delivery_provider_status_rank(text) IS
  'Monotonic severity rank for provider delivery outcomes. Keeps out-of-order webhook events from downgrading an observed failure.';

-- Audit trail keeps metadata only: the outcome and its timestamp are metadata,
-- the provider reason text is not and stays out of the log.
CREATE OR REPLACE FUNCTION public.invoice_delivery_audit_state(
  delivery public.invoice_deliveries
)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT jsonb_build_object(
    'id', delivery.id,
    'company_id', delivery.company_id,
    'user_id', delivery.user_id,
    'invoice_id', delivery.invoice_id,
    'channel', delivery.channel,
    'status', delivery.status,
    'document_attachment_id', delivery.document_attachment_id,
    'provider', delivery.provider,
    'provider_status', delivery.provider_status,
    'provider_status_at', delivery.provider_status_at,
    'error_code', delivery.error_code,
    'sent_at', delivery.sent_at,
    'failed_at', delivery.failed_at,
    'retention_expires_at', delivery.retention_expires_at,
    'pii_redacted_at', delivery.pii_redacted_at,
    'created_at', delivery.created_at
  )
$$;

-- Rewritten from 20260723003000. Unchanged except for the provider status
-- columns: the sending flow may never set them, an already sent row may change
-- nothing else, and redaction must clear the reason text with the rest of PII.
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
      OR NEW.provider_status IS NOT NULL
      OR NEW.provider_status_at IS NOT NULL
      OR NEW.provider_status_detail IS NOT NULL
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
      OR NEW.provider_status IS NOT NULL
      OR NEW.provider_status_at IS NOT NULL
      OR NEW.provider_status_detail IS NOT NULL
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

  -- The provider reports the outcome after the send is already terminal. Only
  -- the three provider status columns may move, and only on an unredacted sent
  -- row: subtracting them from the row image proves nothing else changed, so a
  -- column added later is covered without revisiting this branch.
  IF OLD.status = 'sent'
    AND OLD.pii_redacted_at IS NULL
    AND NEW.provider_status IS NOT NULL
    AND (to_jsonb(NEW)
      - 'provider_status' - 'provider_status_at' - 'provider_status_detail' - 'updated_at')
      IS NOT DISTINCT FROM
      (to_jsonb(OLD)
      - 'provider_status' - 'provider_status_at' - 'provider_status_detail' - 'updated_at')
  THEN
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
    AND NEW.provider_status IS NOT DISTINCT FROM OLD.provider_status
    AND NEW.provider_status_at IS NOT DISTINCT FROM OLD.provider_status_at
    AND NEW.provider_status_detail IS NULL
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

-- The provider reason text is recipient-related personal data and expires with
-- the rest of it. Rewritten from 20260722150000 to clear the new column too.
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
      provider_status_detail = NULL,
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

REVOKE ALL ON FUNCTION public.redact_expired_invoice_delivery_pii() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redact_expired_invoice_delivery_pii() TO service_role;

-- Applied from a signed provider webhook, which has no user session: the
-- provider is the actor. The message id is the provider's own identifier and
-- is already unique per provider, so it is the only lookup key needed.
CREATE OR REPLACE FUNCTION public.apply_invoice_delivery_provider_status(
  p_provider text,
  p_provider_message_id text,
  p_status text,
  p_occurred_at timestamptz,
  p_detail text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  target public.invoice_deliveries%ROWTYPE;
  new_rank integer;
  current_rank integer;
  observed_at timestamptz;
  updated_id uuid;
BEGIN
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'invoice delivery provider status requires a server-controlled service role'
      USING ERRCODE = '42501';
  END IF;

  new_rank := public.invoice_delivery_provider_status_rank(p_status);
  IF new_rank = 0 THEN
    RAISE EXCEPTION 'unsupported invoice delivery provider status: %', p_status
      USING ERRCODE = '22023';
  END IF;

  IF p_provider IS NULL OR p_provider_message_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO target
  FROM public.invoice_deliveries d
  WHERE d.provider = p_provider
    AND d.provider_message_id = p_provider_message_id
  FOR UPDATE;

  -- Events for mail that is not a tracked invoice delivery, or for a row that
  -- has passed its retention date, are acknowledged and dropped.
  IF target.id IS NULL
    OR target.status <> 'sent'
    OR target.pii_redacted_at IS NOT NULL
  THEN
    RETURN NULL;
  END IF;

  observed_at := COALESCE(p_occurred_at, now());
  current_rank := public.invoice_delivery_provider_status_rank(target.provider_status);

  IF new_rank < current_rank
    OR (
      new_rank = current_rank
      AND target.provider_status_at IS NOT NULL
      AND observed_at <= target.provider_status_at
    )
  THEN
    RETURN target.id;
  END IF;

  UPDATE public.invoice_deliveries
  SET provider_status = p_status,
      provider_status_at = observed_at,
      provider_status_detail = NULLIF(
        left(regexp_replace(COALESCE(p_detail, ''), '\s+', ' ', 'g'), 500),
        ''
      )
  WHERE id = target.id
  RETURNING id INTO updated_id;

  RETURN updated_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_invoice_delivery_provider_status(
  text, text, text, timestamptz, text
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_invoice_delivery_provider_status(
  text, text, text, timestamptz, text
) TO service_role;

COMMENT ON FUNCTION public.apply_invoice_delivery_provider_status(
  text, text, text, timestamptz, text
) IS
  'Applies a signed provider delivery report to the matching sent invoice delivery. Idempotent and monotonic: a lower ranked or older report is a no-op.';

-- Reason text can quote the failing address, so it is masked exactly like the
-- recipient list before it leaves the server.
DROP FUNCTION IF EXISTS public.list_invoice_delivery_summaries(uuid, uuid);

CREATE FUNCTION public.list_invoice_delivery_summaries(
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
  provider_status text,
  provider_status_at timestamptz,
  provider_status_detail text,
  error_code text,
  document_attachment_id uuid,
  attachment_filename text,
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
    d.provider_status,
    d.provider_status_at,
    regexp_replace(d.provider_status_detail, '[A-Za-z0-9._%+-]+@', '***@', 'g'),
    d.error_code,
    d.document_attachment_id,
    d.attachment_filename,
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
  'Returns active-company invoice delivery status, including the provider delivery outcome, with masked To and CC addresses and a masked provider reason text. Exact payload and BCC remain server-side.';

NOTIFY pgrst, 'reload schema';
