-- Re-admit 'processing' to the invoice_inbox_items.status CHECK.
--
-- Staged upload needs an in-flight state: the web upload route now inserts
-- the inbox row BEFORE AI extraction runs (status 'processing',
-- extracted_data NULL), answers the request immediately, and a deferred
-- worker flips the row to 'received' once extraction lands (or the sweep
-- cron does, after a crashed worker).
--
-- Supersedes the 20260504180000 tightening that removed 'processing': that
-- removal assumed extraction always completes synchronously before the row
-- exists, which stops being true with the staged upload. Email and WhatsApp
-- ingestion keep the synchronous path and never write 'processing'.
ALTER TABLE public.invoice_inbox_items
  DROP CONSTRAINT IF EXISTS invoice_inbox_items_status_check;

ALTER TABLE public.invoice_inbox_items
  ADD CONSTRAINT invoice_inbox_items_status_check
  CHECK (status IN ('received', 'processing', 'error'));

-- Unchanged, restated so the default survives the constraint swap verbatim:
-- rows still land as 'received' unless the writer says otherwise.
ALTER TABLE public.invoice_inbox_items
  ALTER COLUMN status SET DEFAULT 'received';

NOTIFY pgrst, 'reload schema';
