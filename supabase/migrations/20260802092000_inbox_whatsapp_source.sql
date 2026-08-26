-- WhatsApp channel, part 3/3: widen the inbox to the new source.
--
-- invoice_inbox_items.source and document_attachments.upload_source were
-- created as inline column CHECKs, so their constraint names are the
-- Postgres auto-generated <table>_<column>_check (verified: no later
-- migration re-created either). NOT VALID -> VALIDATE keeps the ADD cheap
-- on the large tables; the pg-real suite (whatsapp-tables.pg.test.ts)
-- asserts a 'whatsapp' insert succeeds, which fails loudly if the drop
-- missed a differently-named constraint and the old CHECK survived.

ALTER TABLE public.invoice_inbox_items
  DROP CONSTRAINT IF EXISTS invoice_inbox_items_source_check;
ALTER TABLE public.invoice_inbox_items
  ADD CONSTRAINT invoice_inbox_items_source_check
  CHECK (source IN ('email','upload','whatsapp')) NOT VALID;
ALTER TABLE public.invoice_inbox_items
  VALIDATE CONSTRAINT invoice_inbox_items_source_check;

-- Provenance link back to the chat message that delivered the file
-- (quoted-reply resolution + idempotency at the item level), and the
-- chat-context container for clarifying-question answers. channel_context
-- is deliberately SEPARATE from extracted_data: retry-extraction
-- overwrites extracted_data wholesale, and verified human answers must
-- never share a container with untrusted OCR output.
ALTER TABLE public.invoice_inbox_items
  ADD COLUMN IF NOT EXISTS whatsapp_message_id uuid REFERENCES public.whatsapp_messages(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS channel_context jsonb;

CREATE UNIQUE INDEX IF NOT EXISTS invoice_inbox_items_whatsapp_msg
  ON public.invoice_inbox_items (whatsapp_message_id)
  WHERE whatsapp_message_id IS NOT NULL;

ALTER TABLE public.document_attachments
  DROP CONSTRAINT IF EXISTS document_attachments_upload_source_check;
ALTER TABLE public.document_attachments
  ADD CONSTRAINT document_attachments_upload_source_check
  CHECK (upload_source IN (
    'camera', 'file_upload', 'email', 'e_invoice', 'scan', 'api', 'system', 'whatsapp'
  )) NOT VALID;
ALTER TABLE public.document_attachments
  VALIDATE CONSTRAINT document_attachments_upload_source_check;

NOTIFY pgrst, 'reload schema';
