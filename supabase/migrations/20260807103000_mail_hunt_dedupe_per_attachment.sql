-- The unit of an underlag is an attachment, not a message.
--
-- 20260807090100 made (company_id, mail_message_id) unique for hunted mail, on
-- the assumption that one mail carries one receipt. A provkörning against a
-- real mailbox disproved it: receipts reach these inboxes by being forwarded in
-- batches, and a single message routinely carries several receipts for
-- different purchases ("Fwd: Kvitton februari" with five attachments, "Fwd:
-- Anthropic receipts" with two covering two different months).
--
-- Under the old index the first attachment filed would block every other
-- receipt in the same forward, silently and permanently. The key becomes
-- message + attachment.
--
-- Backfill first, so the new index can be created on existing rows: anything
-- already ingested was filed one-per-message, and its file key is derived from
-- the attachment id captured at the time.
UPDATE public.invoice_inbox_items
SET channel_context = channel_context || jsonb_build_object(
      'mail_file_key',
      (channel_context->>'mail_message_id') || '::' ||
        COALESCE(channel_context->>'mail_attachment_id', '')
    )
WHERE source = 'mail_hunt'
  AND channel_context ? 'mail_message_id'
  AND NOT (channel_context ? 'mail_file_key');

DROP INDEX IF EXISTS public.idx_invoice_inbox_mail_message_unique;

CREATE UNIQUE INDEX IF NOT EXISTS idx_invoice_inbox_mail_file_unique
  ON public.invoice_inbox_items (company_id, ((channel_context->>'mail_file_key')))
  WHERE source = 'mail_hunt';

NOTIFY pgrst, 'reload schema';
