-- document_classifications: a document's classifications, and a company's.
--
-- The table keeps every classification a document has had; one of them is
-- current. Its indexes are all partial on "WHERE is_current" (document_id
-- unique, (company_id, doc_type), (company_id, content_sha256)), so any
-- question that does not say "current" reads the whole table. Three do. On
-- production (read-only EXPLAIN ANALYZE, 2026-11-12; 121 376 rows, 90 MB,
-- 11 500 pages):
--
-- 1. "Has this document been classified before, current or not?"
--    (classifyUnclassifiedDocuments, lib/documents/classify/classify.ts:
--    SELECT document_id ... WHERE document_id = ANY ($1)), once per company on
--    every run of the classify cron, every five minutes: Seq Scan of all
--    121 376 rows for 50 ids, 94 ms, 11 600 buffers. 10 296 calls since
--    2026-09-11, mean 36 ms, 7 671 blocks per call.
-- 2. The foreign key to document_attachments (ON DELETE CASCADE): deleting
--    one document makes Postgres look for its classifications by
--    document_id, with no "is_current" in that lookup: 52.6 ms and the whole
--    table per deleted document (lib/core/documents/document-service.ts, and
--    every document of a sandbox company the nightly cleanup removes).
-- 3. The foreign keys to companies (ON DELETE CASCADE) and to auth.users
--    (decided_by_user_id): one whole-table read each, 30 ms and 64 ms, per
--    company and per user the nightly sandbox cleanup deletes. See
--    20261112214705 for the rest of that cleanup.
--
-- All three grow with the table: at ten times the classifications the cron's
-- check is about a second per company per run and a document delete half a
-- second.
--
-- (document_id) answers 1 and 2. (company_id, created_at) answers the company
-- key in 3 and, with the second column, the two reads that list a company's
-- classifications by time (the Arkiv history, lib/arkiv/history.ts, newest
-- first with a limit; the archive export, oldest first). decided_by_user_id
-- is set on 0.4 % of the rows (the ones a person decided), so its index is
-- partial: "decided_by_user_id = $1" is strict and proves the predicate.
--
-- Plain CREATE INDEX, not CONCURRENTLY (precedent 20261031110200). The three
-- builds hold a SHARE lock on document_classifications until the migration
-- commits: reads go on, new classifications wait. 90 MB heap; expect about a
-- second in all. Before the first build can start it waits behind any write
-- transaction already open on the table, and new classifications queue
-- behind it; lock_timeout caps that wait at 5 s, past which the migration
-- fails whole and is run again (IF NOT EXISTS).
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_document_classifications_document_id
  ON public.document_classifications (document_id);

CREATE INDEX IF NOT EXISTS idx_document_classifications_company_created
  ON public.document_classifications (company_id, created_at);

CREATE INDEX IF NOT EXISTS idx_document_classifications_decided_by_user
  ON public.document_classifications (decided_by_user_id)
  WHERE decided_by_user_id IS NOT NULL;
