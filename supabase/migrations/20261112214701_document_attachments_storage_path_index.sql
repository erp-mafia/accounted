-- document_attachments (storage_path): the document behind a proxied download.
--
-- Every document a browser opens goes through the storage proxy
-- (GET /api/storage/[...path], lookupServedDocument in
-- src/app/api/storage/[...path]/route.ts), which reads the row's mime type
-- and file name by its storage key:
--   SELECT mime_type, file_name FROM document_attachments
--   WHERE storage_path = $1 LIMIT 1
-- No index held storage_path, so each view read every company's documents:
-- a parallel sequential scan of the whole table, every row read and
-- discarded for the one returned. The statement runs once for every
-- document a browser opens, so that scan was paid on every view. The cost
-- follows the table, not the document: as the archive of all companies
-- grows, every view of any document slows with it, and a cold read slows
-- the most.
--
-- With the index the lookup is one probe, whatever the table holds.
--
-- Not UNIQUE: nothing here needs the constraint, and a duplicate path in old
-- rows would fail the build with the code already live.
--
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside the
-- migration transaction (precedent 20261031110200, 20261027060517). The
-- build holds a SHARE lock on document_attachments: reads go on, writes
-- (uploads, page stamps, links) wait for the build. Expect them to pause
-- for the seconds the build takes, as writes to journal_entries did for
-- idx_journal_entries_posted_needs_doc (20261023093920).
--
-- Before the build can start it waits for its SHARE lock behind any write
-- transaction already open on the table, and every writer that arrives
-- after it queues behind it. lock_timeout caps that wait at 5 s: past it
-- the migration fails whole and is run again (IF NOT EXISTS) instead of
-- holding up uploads behind a long transaction (precedent 20261109090000).
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_document_attachments_storage_path
  ON public.document_attachments (storage_path);
