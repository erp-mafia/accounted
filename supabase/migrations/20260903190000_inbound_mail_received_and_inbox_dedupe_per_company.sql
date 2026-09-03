-- Inbound mail traceability (#2181).
--
-- 1. Register the InboundMailReceived behandlingshistorik event: one row per
--    received mail and inbox, written by the Resend inbound webhook
--    (extensions/general/invoice-inbox/index.ts) with the recipient
--    addresses, the +lev/+ver tags, the resolved kind hint and the outcome
--    per attachment (filed, duplicate, rejected, failed). A mail whose every
--    attachment failed used to leave no trace a user could find.
--
--    processing_history.event_type has an FK to processing_event_types, so an
--    unregistered type fails the insert; the append is best-effort, so the
--    record would be silently lost. Catalog row only: aggregate_type 'System'
--    is already permitted by the CHECK.
--
-- 2. Make the per-attachment idempotency key company-scoped. One mail can be
--    addressed to two companies' inbox addresses at once; the webhook now
--    files it once per inbox, and the old (resend_email_id,
--    resend_attachment_id) unique index refused the second company's row.
--    Resend retries still dedupe: the same mail, attachment and company hit
--    the new index.

INSERT INTO public.processing_event_types (event_type) VALUES
  ('InboundMailReceived')
ON CONFLICT (event_type) DO NOTHING;

DROP INDEX IF EXISTS public.idx_invoice_inbox_items_resend_email_attachment;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_items_company_resend_email_attachment
  ON public.invoice_inbox_items(company_id, resend_email_id, resend_attachment_id)
  WHERE resend_email_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
