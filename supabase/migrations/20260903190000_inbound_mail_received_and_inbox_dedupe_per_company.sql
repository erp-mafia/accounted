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
--    The event carries ids and a closed vocabulary (inbox_id, +lev/+ver
--    tags, outcome codes). The database strips any address or free text an
--    older or wrong emitter might send, the same way 20260901110000 does for
--    RateLimitedDropped and AttachmentsTruncated: the invariant belongs to
--    the table, not to one emitter's good behaviour.
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

CREATE OR REPLACE FUNCTION public.strip_inbound_mail_pii_from_processing_history()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.event_type IN ('RateLimitedDropped', 'AttachmentsTruncated', 'InboundMailReceived')
     AND jsonb_typeof(NEW.payload) = 'object'
  THEN
    NEW.payload := NEW.payload - 'from' - 'subject' - 'recipients' - 'to';
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.strip_inbound_mail_pii_from_processing_history()
  FROM PUBLIC, anon, authenticated;

-- Recreated rather than assumed: the trigger ships in 20260901110000, but a
-- database that skipped that file (the staging branch did) would otherwise
-- carry the new function with nothing calling it.
DROP TRIGGER IF EXISTS processing_history_strip_inbound_mail_pii ON public.processing_history;

CREATE TRIGGER processing_history_strip_inbound_mail_pii
  BEFORE INSERT ON public.processing_history
  FOR EACH ROW
  EXECUTE FUNCTION public.strip_inbound_mail_pii_from_processing_history();

-- Plain DROP INDEX / CREATE INDEX (not CONCURRENTLY): Supabase branching
-- applies migrations inside a transaction, where CONCURRENTLY is not allowed
-- (same call as 20260706120000 and 20260710101000). invoice_inbox_items is a
-- few thousand rows on prod; both statements take milliseconds.
DROP INDEX IF EXISTS public.idx_invoice_inbox_items_resend_email_attachment;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_items_company_resend_email_attachment
  ON public.invoice_inbox_items(company_id, resend_email_id, resend_attachment_id)
  WHERE resend_email_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
