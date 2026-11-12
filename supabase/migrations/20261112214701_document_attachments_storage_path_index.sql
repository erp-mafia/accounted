-- document_attachments (storage_path): the document behind a proxied download.
--
-- Every document a browser opens goes through the storage proxy
-- (GET /api/storage/[...path], lookupServedDocument in
-- src/app/api/storage/[...path]/route.ts), which reads the row's mime type
-- and file name by its storage key:
--   SELECT mime_type, file_name FROM document_attachments
--   WHERE storage_path = $1 LIMIT 1
-- No index held storage_path, so each view read every company's documents.
-- On production (read-only EXPLAIN ANALYZE, 2026-11-12, one real path of the
-- company with the most documents): Parallel Seq Scan, 363 000 rows read for
-- the one returned, 37 900 buffers (the whole 296 MB heap), 1 430 ms cold.
-- Since 2026-09-11 the statement ran 10 814 times, mean 54 ms, 16 417 blocks
-- per call. The cost follows the table, not the document: at ten times the
-- archive every view is about half a second warm and over ten seconds cold.
--
-- With the index the lookup is one probe, whatever the table holds.
--
-- Not UNIQUE: nothing here needs the constraint, and a duplicate path in old
-- rows would fail the build with the code already live.
--
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside the
-- migration transaction (precedent 20261031110200, 20261027060517). The
-- build holds a SHARE lock on document_attachments: reads go on, writes
-- (uploads, page stamps, links) wait for the build. 359 000 rows, 296 MB
-- heap on production; idx_journal_entries_posted_needs_doc on a 723 MB heap
-- took 4.7 s (2026-10-23), so expect writes to pause for 1 to 3 s.
--
-- Before the build can start it waits for its SHARE lock behind any write
-- transaction already open on the table, and every writer that arrives
-- after it queues behind it. lock_timeout caps that wait at 5 s: past it
-- the migration fails whole and is run again (IF NOT EXISTS) instead of
-- holding up uploads behind a long transaction (precedent 20261109090000).
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_document_attachments_storage_path
  ON public.document_attachments (storage_path);
