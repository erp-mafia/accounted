-- Per-recipient provider outcomes for invoice email delivery.
--
-- Resend's delivery webhooks identify the affected addresses in data.to. The
-- addresses already live in immutable To/CC arrays, so outcomes can be stored
-- without duplicating PII: keys such as to:1 and cc:2 refer to array positions.
-- BCC recipients and unmatched addresses are deliberately never represented.

ALTER TABLE public.invoice_deliveries
  ADD COLUMN provider_recipient_statuses jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE OR REPLACE FUNCTION public.invoice_delivery_recipient_statuses_valid(
  p_statuses jsonb,
  p_to_addresses text[],
  p_cc_addresses text[]
)
RETURNS boolean
LANGUAGE plpgsql
IMMUTABLE
SET search_path = pg_catalog, public
AS $$
DECLARE
  recipient_reference text;
  recipient_outcome jsonb;
  status_at_text text;
BEGIN
  IF p_statuses IS NULL OR jsonb_typeof(p_statuses) <> 'object' THEN
    RETURN false;
  END IF;

  FOR recipient_reference, recipient_outcome IN
    SELECT entry.key, entry.value
    FROM jsonb_each(p_statuses) AS entry
  LOOP
    IF recipient_reference !~ '^(to|cc):[1-9][0-9]*$'
      OR jsonb_typeof(recipient_outcome) <> 'object'
      OR NOT recipient_outcome ? 'status'
      OR NOT recipient_outcome ? 'status_at'
      OR (recipient_outcome - 'status' - 'status_at') <> '{}'::jsonb
      OR jsonb_typeof(recipient_outcome -> 'status') <> 'string'
      OR jsonb_typeof(recipient_outcome -> 'status_at') <> 'string'
      OR recipient_outcome ->> 'status' NOT IN (
        'delayed', 'delivered', 'complained', 'bounced', 'failed', 'suppressed'
      )
    THEN
      RETURN false;
    END IF;

    IF recipient_reference LIKE 'to:%'
      AND NOT EXISTS (
        SELECT 1
        FROM generate_subscripts(p_to_addresses, 1) AS positions(position)
        WHERE recipient_reference = 'to:' || positions.position
      )
    THEN
      RETURN false;
    END IF;

    IF recipient_reference LIKE 'cc:%'
      AND NOT EXISTS (
        SELECT 1
        FROM generate_subscripts(p_cc_addresses, 1) AS positions(position)
        WHERE recipient_reference = 'cc:' || positions.position
      )
    THEN
      RETURN false;
    END IF;

    status_at_text := recipient_outcome ->> 'status_at';
    IF status_at_text !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$' THEN
      RETURN false;
    END IF;

    BEGIN
      PERFORM status_at_text::timestamptz;
    EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN
      RETURN false;
    END;
  END LOOP;

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.invoice_delivery_recipient_statuses_valid(jsonb, text[], text[])
  FROM PUBLIC, anon, authenticated;

ALTER TABLE public.invoice_deliveries
  ADD CONSTRAINT invoice_deliveries_recipient_statuses_shape CHECK (
    public.invoice_delivery_recipient_statuses_valid(
      provider_recipient_statuses,
      to_addresses,
      cc_addresses
    )
    AND (
      provider_recipient_statuses = '{}'::jsonb
      OR (channel = 'email' AND status = 'sent')
    )
  ) NOT VALID;

ALTER TABLE public.invoice_deliveries
  VALIDATE CONSTRAINT invoice_deliveries_recipient_statuses_shape;

COMMENT ON COLUMN public.invoice_deliveries.provider_recipient_statuses IS
  'PII-free provider outcomes keyed by immutable To/CC position (for example to:1). Exact addresses, BCC recipients, and unmatched webhook recipients are never stored here.';

COMMENT ON COLUMN public.invoice_deliveries.provider_status IS
  'Highest-ranked delivery outcome reported by the email provider for the message. Per-recipient detail, when available, is stored separately by PII-free To/CC position.';

-- Recipient outcomes are metadata and contain no address or reason text, so
-- they may be included in the minimized audit image alongside aggregate state.
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
    'provider_recipient_statuses', delivery.provider_recipient_statuses,
    'error_code', delivery.error_code,
    'sent_at', delivery.sent_at,
    'failed_at', delivery.failed_at,
    'retention_expires_at', delivery.retention_expires_at,
    'pii_redacted_at', delivery.pii_redacted_at,
    'created_at', delivery.created_at
  )
$$;

-- Preserve the WORM evidence contract. A sent, unredacted row may change only
-- the provider outcome fields; every other column remains immutable.
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
      user_id, company_id, action, table_name, record_id, actor_id,
      old_state, description
    ) VALUES (
      OLD.user_id, OLD.company_id, 'SECURITY_EVENT', 'invoice_deliveries',
      OLD.id, auth.uid(), public.invoice_delivery_audit_state(OLD),
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
      OR NEW.provider_recipient_statuses <> '{}'::jsonb
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
      OR NEW.provider_recipient_statuses <> '{}'::jsonb
      OR (
        NEW.status = 'sent'
        AND NEW.document_attachment_id IS DISTINCT FROM OLD.document_attachment_id
      )
      OR (NEW.status = 'failed' AND NEW.document_attachment_id IS NOT NULL)
    THEN
      RAISE EXCEPTION 'invoice delivery payload is immutable'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'sent'
    AND OLD.pii_redacted_at IS NULL
    AND NEW.provider_status IS NOT NULL
    AND (to_jsonb(NEW)
      - 'provider_status'
      - 'provider_status_at'
      - 'provider_status_detail'
      - 'provider_recipient_statuses'
      - 'updated_at')
      IS NOT DISTINCT FROM
      (to_jsonb(OLD)
      - 'provider_status'
      - 'provider_status_at'
      - 'provider_status_detail'
      - 'provider_recipient_statuses'
      - 'updated_at')
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
    AND NEW.provider_recipient_statuses = '{}'::jsonb
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

-- Recipient references stop being useful once the address arrays expire, and
-- their keys would otherwise retain the old recipient counts. Clear them with
-- the rest of the delivery PII while retaining only the aggregate outcome.
CREATE OR REPLACE FUNCTION public.redact_expired_invoice_delivery_pii()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
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
      provider_recipient_statuses = '{}'::jsonb,
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

-- Apply the aggregate outcome first for backward compatibility, then merge
-- each impacted To/CC position independently. Both layers use the same rank
-- and provider timestamp ordering, making retries and out-of-order events safe.
CREATE OR REPLACE FUNCTION public.apply_invoice_delivery_provider_event(
  p_provider text,
  p_provider_message_id text,
  p_status text,
  p_occurred_at timestamptz,
  p_detail text,
  p_recipient_addresses text[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  applied_id uuid;
  target public.invoice_deliveries%ROWTYPE;
  observed_at timestamptz := COALESCE(p_occurred_at, now());
  new_rank integer;
  normalized_address text;
  recipient_address text;
  recipient_position integer;
  recipient_reference text;
  existing_outcome jsonb;
  existing_rank integer;
  existing_at timestamptz;
  next_statuses jsonb;
BEGIN
  applied_id := public.apply_invoice_delivery_provider_status(
    p_provider,
    p_provider_message_id,
    p_status,
    observed_at,
    p_detail
  );

  IF applied_id IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT * INTO STRICT target
  FROM public.invoice_deliveries AS delivery
  WHERE delivery.id = applied_id
  FOR UPDATE;

  IF p_recipient_addresses IS NULL OR cardinality(p_recipient_addresses) = 0 THEN
    RETURN applied_id;
  END IF;

  new_rank := public.invoice_delivery_provider_status_rank(p_status);
  next_statuses := target.provider_recipient_statuses;

  FOREACH recipient_address IN ARRAY p_recipient_addresses
  LOOP
    normalized_address := lower(btrim(recipient_address));
    IF normalized_address IS NULL
      OR normalized_address = ''
      OR length(normalized_address) > 320
    THEN
      CONTINUE;
    END IF;

    FOR recipient_reference, recipient_position IN
      SELECT 'to:' || positions.position, positions.position
      FROM generate_subscripts(target.to_addresses, 1) AS positions(position)
      WHERE lower(btrim(target.to_addresses[positions.position])) = normalized_address
      UNION ALL
      SELECT 'cc:' || positions.position, positions.position
      FROM generate_subscripts(target.cc_addresses, 1) AS positions(position)
      WHERE lower(btrim(target.cc_addresses[positions.position])) = normalized_address
    LOOP
      existing_outcome := next_statuses -> recipient_reference;
      existing_rank := public.invoice_delivery_provider_status_rank(
        existing_outcome ->> 'status'
      );
      existing_at := NULLIF(existing_outcome ->> 'status_at', '')::timestamptz;

      IF new_rank < existing_rank
        OR (new_rank = existing_rank AND existing_at IS NOT NULL AND observed_at <= existing_at)
      THEN
        CONTINUE;
      END IF;

      next_statuses := jsonb_set(
        next_statuses,
        ARRAY[recipient_reference],
        jsonb_build_object('status', p_status, 'status_at', observed_at),
        true
      );
    END LOOP;
  END LOOP;

  IF next_statuses IS DISTINCT FROM target.provider_recipient_statuses THEN
    UPDATE public.invoice_deliveries
    SET provider_recipient_statuses = next_statuses
    WHERE id = applied_id;
  END IF;

  RETURN applied_id;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_invoice_delivery_provider_event(
  text, text, text, timestamptz, text, text[]
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_invoice_delivery_provider_event(
  text, text, text, timestamptz, text, text[]
) TO service_role;

COMMENT ON FUNCTION public.apply_invoice_delivery_provider_event(
  text, text, text, timestamptz, text, text[]
) IS
  'Applies one signed provider event to aggregate invoice delivery state and independently to matching immutable To/CC positions. Service role only; BCC and unknown recipients are ignored.';

-- Both read surfaces return the same minimized PII-free status map alongside
-- their already-masked To/CC arrays.
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
  provider_recipient_statuses jsonb,
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
      SELECT 1 FROM public.company_members AS member
      WHERE member.company_id = p_company_id AND member.user_id = auth.uid()
    )
  THEN
    RAISE EXCEPTION 'not authorized to list invoice delivery summaries'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    delivery.id,
    delivery.channel,
    delivery.status,
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(delivery.to_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(delivery.cc_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    delivery.provider,
    delivery.provider_status,
    delivery.provider_status_at,
    regexp_replace(delivery.provider_status_detail, '[A-Za-z0-9._%+-]+@', '***@', 'g'),
    delivery.provider_recipient_statuses,
    delivery.error_code,
    delivery.document_attachment_id,
    delivery.attachment_filename,
    delivery.sent_at,
    delivery.failed_at,
    delivery.created_at
  FROM public.invoice_deliveries AS delivery
  WHERE delivery.company_id = p_company_id
    AND delivery.invoice_id = p_invoice_id
    AND delivery.status <> 'preparing'
  ORDER BY delivery.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) TO authenticated;

COMMENT ON FUNCTION public.list_invoice_delivery_summaries(uuid, uuid) IS
  'Returns active-company invoice delivery status with masked To/CC addresses and PII-free recipient outcomes keyed by their positions. Exact payload and BCC remain server-side.';

DROP FUNCTION IF EXISTS public.list_invoice_delivery_summaries_for_service(uuid, uuid, uuid);

CREATE FUNCTION public.list_invoice_delivery_summaries_for_service(
  p_company_id uuid,
  p_user_id uuid,
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
  provider_recipient_statuses jsonb,
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
  IF auth.role() IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'invoice delivery summaries require a server-controlled service role'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.company_members AS member
    WHERE member.company_id = p_company_id AND member.user_id = p_user_id
  ) THEN
    RAISE EXCEPTION 'invoice delivery reader is not a company member'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    delivery.id,
    delivery.channel,
    delivery.status,
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(delivery.to_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    ARRAY(
      SELECT CASE
        WHEN recipient.address ~ '^[^@]+@[^@]+$'
          THEN '***@' || split_part(recipient.address, '@', 2)
        ELSE '***'
      END
      FROM unnest(delivery.cc_addresses) WITH ORDINALITY AS recipient(address, position)
      ORDER BY recipient.position
    ),
    delivery.provider,
    delivery.provider_status,
    delivery.provider_status_at,
    regexp_replace(delivery.provider_status_detail, '[A-Za-z0-9._%+-]+@', '***@', 'g'),
    delivery.provider_recipient_statuses,
    delivery.error_code,
    delivery.document_attachment_id,
    delivery.attachment_filename,
    delivery.sent_at,
    delivery.failed_at,
    delivery.created_at
  FROM public.invoice_deliveries AS delivery
  WHERE delivery.company_id = p_company_id
    AND delivery.invoice_id = p_invoice_id
    AND delivery.status <> 'preparing'
  ORDER BY delivery.created_at DESC;
END;
$$;

REVOKE ALL ON FUNCTION public.list_invoice_delivery_summaries_for_service(uuid, uuid, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_invoice_delivery_summaries_for_service(uuid, uuid, uuid)
  TO service_role;

COMMENT ON FUNCTION public.list_invoice_delivery_summaries_for_service(uuid, uuid, uuid) IS
  'Service-role read of invoice delivery status for a named company member. Same masked To/CC and PII-free recipient outcome shape as the cookie-session function; BCC remains server-side.';

NOTIFY pgrst, 'reload schema';
