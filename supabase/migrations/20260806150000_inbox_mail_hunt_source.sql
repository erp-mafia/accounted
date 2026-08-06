-- Migration: 'mail_hunt' as an inbox and document source
--
-- A receipt the hunt fetched out of a connected mailbox is a fourth way a
-- document enters the system, alongside a forwarded email, a manual upload and
-- a WhatsApp photo. It needs its own source value for two reasons that matter
-- later: provenance ("hämtat ur ekonomi@ den 6 augusti" is what makes the
-- proposal trustworthy), and the ability to find every hunted document again if
-- a grant is ever withdrawn or disputed.
--
-- Same shape as 20260802092000, which added 'whatsapp': widen both CHECKs
-- NOT VALID so the rewrite is cheap and existing rows are not re-scanned, then
-- validate in a follow-up statement once the new value is in use.
--
-- Existing rows: untouched; nothing is written with the new value until the
-- mail extension is connected for a company.

ALTER TABLE public.invoice_inbox_items
  DROP CONSTRAINT IF EXISTS invoice_inbox_items_source_check;

ALTER TABLE public.invoice_inbox_items
  ADD CONSTRAINT invoice_inbox_items_source_check
  CHECK (source IN ('email', 'upload', 'whatsapp', 'mail_hunt')) NOT VALID;

ALTER TABLE public.invoice_inbox_items
  VALIDATE CONSTRAINT invoice_inbox_items_source_check;

ALTER TABLE public.document_attachments
  DROP CONSTRAINT IF EXISTS document_attachments_upload_source_check;

ALTER TABLE public.document_attachments
  ADD CONSTRAINT document_attachments_upload_source_check
  CHECK (upload_source IN (
    'camera', 'file_upload', 'email', 'e_invoice', 'scan', 'api', 'system',
    'whatsapp', 'mail_hunt'
  )) NOT VALID;

ALTER TABLE public.document_attachments
  VALIDATE CONSTRAINT document_attachments_upload_source_check;

-- The hunt must never ingest the same message twice, across re-runs and across
-- two mailboxes that both received the same forwarded receipt. Partial so it
-- costs nothing for the other three sources.
CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_mail_message_unique
  ON public.invoice_inbox_items (company_id, ((channel_context->>'mail_message_id')))
  WHERE source = 'mail_hunt';

NOTIFY pgrst, 'reload schema';
