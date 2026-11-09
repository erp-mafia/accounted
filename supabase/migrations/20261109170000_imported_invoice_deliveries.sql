-- accounted#165: the customer-invoice PDF imported from the previous system is
-- the archived copy of that invoice. It is recorded as an invoice delivery
-- with channel 'import': no recipients and no message (Accounted sent
-- nothing), only the provider, its reference and the archived document, so
-- the existing archived-PDF source (latest sent delivery with a document)
-- serves it and block_sent_invoice_document_deletion keeps the file.
--
-- invoice_deliveries is written on every invoice send: fail the migration job
-- instead of queueing sends behind a long lock.
SELECT set_config('lock_timeout', '5s', true);

-- Both constraints are rebuilt from their current definitions
-- (payload_shape: 20260722190000_invoice_email_cc_bcc.sql; channel_check: the
-- inline column CHECK of 20260722101319_invoice_deliveries.sql) with only the
-- 'import' channel added.
ALTER TABLE public.invoice_deliveries
  DROP CONSTRAINT invoice_deliveries_channel_check,
  ADD CONSTRAINT invoice_deliveries_channel_check
    CHECK (channel IN ('email', 'manual', 'import')),
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
    OR
    (
      -- An import holds no personal data to redact (the redaction job reads
      -- channel 'email' only), so pii_redacted_at stays NULL and the row is
      -- terminal from its insert: enforce_invoice_delivery_immutability
      -- refuses every UPDATE and DELETE of a 'sent' row outside redaction,
      -- and a redaction-shaped update would fail this branch.
      channel = 'import'
      AND status = 'sent'
      AND pii_redacted_at IS NULL
      AND cardinality(to_addresses) = 0
      AND cardinality(cc_addresses) = 0
      AND cardinality(bcc_addresses) = 0
      AND reply_to IS NULL
      AND from_name IS NULL
      AND subject IS NULL
      AND body_text IS NULL
      AND body_html IS NULL
      AND provider IS NOT NULL
      AND provider_message_id IS NOT NULL
      AND error_code IS NULL
      AND document_attachment_id IS NOT NULL
      AND attachment_filename IS NOT NULL
      AND attachment_content_type IS NOT NULL
      AND attachment_sha256 IS NOT NULL
    )
  );

-- An invoice was issued once, so it has at most one imported original. The
-- index is the atomic claim two concurrent import runs meet on: the second
-- insert does nothing, and its caller discards the copy it stored.
CREATE UNIQUE INDEX idx_invoice_deliveries_import_invoice
  ON public.invoice_deliveries (invoice_id)
  WHERE channel = 'import';

-- Direct delivery writes are closed to authenticated users
-- (20260723003000_restrict_invoice_delivery_payload_select.sql), so the import
-- writes through a service-only RPC like every other delivery. The evidence
-- columns are read from the stored document, never taken from the caller.
-- Returns the new delivery id, or NULL when the invoice already holds its
-- imported original.
CREATE OR REPLACE FUNCTION public.record_imported_invoice_delivery(
  p_company_id uuid,
  p_invoice_id uuid,
  p_actor_user_id uuid,
  p_provider text,
  p_provider_message_id text,
  p_document_attachment_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_actor_id uuid;
  v_file_name text;
  v_mime_type text;
  v_sha256 text;
  v_delivery_id uuid;
BEGIN
  v_actor_id := public.authorize_invoice_delivery_service_actor(
    p_company_id,
    p_actor_user_id
  );

  IF p_provider IS NULL OR btrim(p_provider) = ''
    OR p_provider_message_id IS NULL OR btrim(p_provider_message_id) = ''
  THEN
    RAISE EXCEPTION 'imported invoice delivery needs its provider reference'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.invoices i
    WHERE i.id = p_invoice_id
      AND i.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'invoice not found in company'
      USING ERRCODE = '23514';
  END IF;

  SELECT da.file_name, da.mime_type, da.sha256_hash
    INTO v_file_name, v_mime_type, v_sha256
  FROM public.document_attachments da
  WHERE da.id = p_document_attachment_id
    AND da.company_id = p_company_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'imported invoice document not found in company'
      USING ERRCODE = '23514';
  END IF;

  INSERT INTO public.invoice_deliveries (
    company_id, user_id, invoice_id, channel, status,
    provider, provider_message_id,
    document_attachment_id, attachment_filename, attachment_content_type,
    attachment_sha256, sent_at
  ) VALUES (
    p_company_id, v_actor_id, p_invoice_id, 'import', 'sent',
    p_provider, p_provider_message_id,
    p_document_attachment_id, v_file_name, v_mime_type,
    v_sha256, now()
  )
  ON CONFLICT (invoice_id) WHERE channel = 'import' DO NOTHING
  RETURNING id INTO v_delivery_id;

  RETURN v_delivery_id;
END;
$$;

REVOKE ALL ON FUNCTION public.record_imported_invoice_delivery(uuid, uuid, uuid, text, text, uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.record_imported_invoice_delivery(uuid, uuid, uuid, text, text, uuid)
  TO service_role;

COMMENT ON FUNCTION public.record_imported_invoice_delivery(uuid, uuid, uuid, text, text, uuid) IS
  'Service-only: records the customer-invoice PDF imported from the previous system as the invoice''s archived copy. NULL when the invoice already has one.';

COMMENT ON TABLE public.invoice_deliveries IS
  'Immutable delivery evidence for customer invoices: a sent email, a manual mark, or the original PDF imported from the previous system.';

NOTIFY pgrst, 'reload schema';
