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

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_mail_message_unique
  ON public.invoice_inbox_items (company_id, ((channel_context->>'mail_message_id')))
  WHERE source = 'mail_hunt';

NOTIFY pgrst, 'reload schema';
