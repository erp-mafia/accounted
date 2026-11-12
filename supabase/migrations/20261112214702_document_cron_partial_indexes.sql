-- document_attachments: the three document crons stop reading the table whole.
--
-- Every five minutes /api/documents/read/cron and /api/documents/classify/cron
-- ask document_attachments, across all companies, for "the next few rows to
-- work on". None of the three questions had an index that answers it, so each
-- run read the table (or most of an index) to hand back a handful of rows.
-- The cost follows the table, and the crons run whether or not there is work.
-- On production (read-only EXPLAIN ANALYZE, 2026-11-12; 363 000 rows, 296 MB
-- heap; calls and means from pg_stat_statements since 2026-09-11):
--
-- 1. document_retry_candidates(p_reasons, p_limit), lib/documents/read/store.ts:
--      WHERE read_error = ANY (p_reasons) ... ORDER BY pages_read_at ASC LIMIT n
--    Parallel Seq Scan of all 363 000 rows, sort of the 54 000 on the retry
--    shelf, 100 returned: 1 559 ms, 40 600 buffers. 13 942 calls, mean 135 ms,
--    max 7 306 ms.
--    idx_document_attachments_read_retry holds only rows with a read_error
--    (about 60 000), oldest stamp first. "read_error = ANY (p_reasons)" is
--    strict, so the planner proves "read_error IS NOT NULL" from it even with
--    the reasons as a parameter (the function runs on a generic plan). The
--    scan stops after the limit instead of sorting the shelf.
--
-- 2. The classify cron's company discovery (classify/cron/route.ts):
--      WHERE doc_type IS NULL AND pages_read_at IS NOT NULL AND page_count > $1
--      ORDER BY created_at DESC LIMIT 500
--    Parallel Seq Scan of all 363 000 rows, 139 600 match, 500 kept: 310 ms
--    warm, 38 000 buffers. 14 271 calls, mean 104 ms, max 4 285 ms.
--    idx_document_attachments_unclassified has the same predicate but leads
--    with company_id, so it cannot give the newest rows across companies.
--    idx_document_attachments_untyped_recent is the same predicate ordered by
--    created_at alone: the 500 newest are the first 500 entries. page_count
--    stays a filter: PostgREST sends its bound as a parameter, and a partial
--    index predicate is only proven from what the statement says literally.
--
-- 3. document_backfill_candidates(p_limit), lib/documents/read/store.ts:
--      WHERE pages_read_at IS NULL AND (mime_type IS NULL OR mime_type NOT IN
--      ('application/xml', 'text/xml', 'application/json')) ...
--      ORDER BY created_at DESC LIMIT n
--    It walked idx_document_attachments_pages_unread (created_at DESC WHERE
--    pages_read_at IS NULL): 109 395 entries, of which 92 579 are structured
--    archives (bank responses, XML payloads) that are never read and are
--    thrown away after the heap fetch, every run, to return nothing: 307 ms,
--    232 000 buffers. 13 941 calls, mean 160 ms, max 7 375 ms, 117 129 blocks
--    per call. Every bank file adds one more archive to walk past.
--    idx_document_attachments_backfill_unread carries the function's own
--    predicate, word for word, so it holds the 16 816 rows a reader could
--    take and none of the archives.
--    What it does not fix: 15 697 of those rows sit on a closed or locked
--    period and 1 119 on a reset company; the function's two anti joins still
--    skip them one by one on every run (about 128 000 of the 232 000
--    buffers). Removing that needs the "cannot be stamped" fact stored
--    somewhere the scan can see, which is a design change, not an index.
--
-- idx_document_attachments_pages_unread stays for now. Its 15 975 scans since
-- 2026-09-11 are about what the backfill accounts for (13 941 through the
-- function, which dates from 2026-09-24; the cron read the same rows with a
-- plain select before that), and no other statement in the code asks for
-- unread rows across companies, so it should go idle after this. Dropping
-- it takes an ACCESS EXCLUSIVE lock on a table every document view reads;
-- once its idx_scan has stood still for a while, drop it in its own
-- migration.
--
-- Plain CREATE INDEX, not CONCURRENTLY: CONCURRENTLY cannot run inside the
-- migration transaction (precedent 20261031110200, 20261027060517). The
-- three builds hold a SHARE lock on document_attachments until the migration
-- commits: reads go on, writes (uploads, page stamps, links) wait. Each build
-- reads the 296 MB heap once and keeps 17 000 to 140 000 entries; expect
-- writes to pause for 2 to 5 s in all.
--
-- Before the first build can start it waits for its SHARE lock behind any
-- write transaction already open on the table, and every writer that
-- arrives after it queues behind it. lock_timeout caps that wait at 5 s:
-- past it the migration fails whole and is run again (IF NOT EXISTS)
-- instead of holding up uploads behind a long transaction (precedent
-- 20261109090000).
SELECT set_config('lock_timeout', '5s', true);

CREATE INDEX IF NOT EXISTS idx_document_attachments_read_retry
  ON public.document_attachments (pages_read_at, read_error)
  WHERE read_error IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_attachments_untyped_recent
  ON public.document_attachments (created_at DESC)
  WHERE doc_type IS NULL AND pages_read_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_document_attachments_backfill_unread
  ON public.document_attachments (created_at DESC)
  WHERE pages_read_at IS NULL
    AND (mime_type IS NULL OR mime_type NOT IN ('application/xml', 'text/xml', 'application/json'));
