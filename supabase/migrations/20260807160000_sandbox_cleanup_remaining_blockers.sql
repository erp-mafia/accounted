-- Last two NO ACTION FK blockers in sandbox teardown, found by draining the
-- prod backlog: processing_history.company_id and
-- invoice_deliveries.company_id reference companies without a cascade, so a
-- sandbox whose visitor exercised AI processing or invoice sending cannot be
-- deleted (7 of ~510 backlog users). A data-driven sweep of every NO ACTION
-- FK into companies confirms these two plus the already-handled audit_log
-- are the only tables with rows for stale sandboxes.
--
-- Body otherwise identical to 20260807130000's cleanup_sandbox_user.

CREATE OR REPLACE FUNCTION public.cleanup_sandbox_user(p_user_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_deleted integer := 0;
BEGIN
  -- Verify this is a sandbox user: at least one settings row, and EVERY
  -- settings row flagged sandbox. A single-row read would pick an arbitrary
  -- row for a hypothetical multi-company user and the user-scoped deletes
  -- below would then reach the real company's rows.
  IF NOT EXISTS (
    SELECT 1 FROM public.company_settings cs WHERE cs.user_id = p_user_id
  ) OR EXISTS (
    SELECT 1 FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox IS NOT TRUE
  ) THEN
    RAISE EXCEPTION 'User % is not a sandbox user', p_user_id;
  END IF;

  -- Sanctioned trigger bypasses, transaction-local and only reachable after
  -- the is_sandbox check above, so real companies can never enter this path.
  PERFORM set_config('gnubok.allow_delete', 'true', true);
  PERFORM set_config('gnubok.sandbox_cleanup', 'true', true);

  -- Clear RESTRICT FKs on document_attachments
  UPDATE public.document_attachments
  SET journal_entry_id = NULL, journal_entry_line_id = NULL
  WHERE user_id = p_user_id;

  DELETE FROM public.document_attachments WHERE user_id = p_user_id;

  -- salary_runs references its booked vouchers with plain NO ACTION FKs.
  UPDATE public.salary_runs
  SET salary_entry_id = NULL,
      avgifter_entry_id = NULL,
      pension_entry_id = NULL,
      vacation_entry_id = NULL
  WHERE user_id = p_user_id;

  -- Delete journal entry lines (child of journal_entries)
  DELETE FROM public.journal_entry_lines
  WHERE journal_entry_id IN (
    SELECT id FROM public.journal_entries WHERE user_id = p_user_id
  );

  DELETE FROM public.journal_entries WHERE user_id = p_user_id;

  -- Delete supplier invoices before suppliers cascade
  DELETE FROM public.supplier_invoices WHERE user_id = p_user_id;

  -- Guarded tables that must go while company_settings still exists (their
  -- delete-protect triggers re-verify sandbox-ness through it).
  DELETE FROM public.pending_operations WHERE user_id = p_user_id;

  DELETE FROM public.dimensions
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Plain NO ACTION company FKs with no cascade: telemetry and delivery
  -- logs the sandbox demo can produce.
  DELETE FROM public.processing_history
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  DELETE FROM public.invoice_deliveries
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Purge the sandbox company's audit rows while company_settings still
  -- exists (audit_log_immutable re-verifies sandbox-ness through it).
  DELETE FROM public.audit_log
  WHERE company_id IN (
    SELECT cs.company_id FROM public.company_settings cs
    WHERE cs.user_id = p_user_id AND cs.is_sandbox = true
  );

  -- Delete from auth.users cascades everything else
  DELETE FROM auth.users WHERE id = p_user_id;
  GET DIAGNOSTICS v_deleted = ROW_COUNT;

  -- Drop the bypasses before returning so nothing later in the same
  -- transaction runs with them still armed.
  PERFORM set_config('gnubok.allow_delete', '', true);
  PERFORM set_config('gnubok.sandbox_cleanup', '', true);

  RETURN v_deleted;
END;
$$;

REVOKE ALL ON FUNCTION public.cleanup_sandbox_user(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cleanup_sandbox_user(uuid) TO service_role;

-- =============================================================================
-- 2. enforce_invoice_delivery_immutability: allow sandbox-teardown DELETE
-- =============================================================================

-- The DELETE branch swallows deletions silently (RETURN NULL plus a
-- SECURITY_EVENT audit row) for anything but stale preparing rows, so the
-- explicit invoice_deliveries delete above was a no-op and the companies FK
-- still blocked teardown for sandboxes that sent a demo invoice. Base
-- definition: 20260803224000; only the DELETE branch gains the bypass.

CREATE OR REPLACE FUNCTION public.enforce_invoice_delivery_immutability()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    -- Sandbox teardown (cleanup_sandbox_user) removes the whole demo
    -- company; without this the DELETE is silently swallowed (RETURN NULL
    -- plus a SECURITY_EVENT audit row) and the companies FK blocks the
    -- teardown. Same transaction-local flag plus per-row sandbox
    -- re-verification as the other guards in 20260807130000.
    IF current_setting('gnubok.sandbox_cleanup', true) = 'true'
      AND EXISTS (
        SELECT 1 FROM public.company_settings cs
        WHERE cs.company_id = OLD.company_id AND cs.is_sandbox = true
      )
    THEN
      RETURN OLD;
    END IF;

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
