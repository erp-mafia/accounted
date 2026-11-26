-- document_attachments: the read backfill's walk over the unread documents,
-- from the index alone.
--
-- document_backfill_candidates walks every unread document newest first until
-- it has its batch, and almost every unread document can never be stamped (it
-- sits on a closed or locked period, or on the source of a migration reset),
-- so a run with little to read walks all of them. The only index for that
-- walk (idx_document_attachments_backfill_unread) holds created_at alone, so
-- each document it passes is a visit to the table for the columns the walk
-- tests: one table page per document, spread over the whole table. With the
-- tested columns in the index the walk reads the index (a few hundred pages)
-- and visits the table only for a row whose page vacuum has not yet marked
-- all-visible. The function reads the full rows of the batch it returns by
-- primary key (20261126000300_document_backfill_candidates_index_only).
--
-- Only fixed-width columns are included: a text column here could make an
-- index row too large and refuse the insert or update of a document.
--
-- Built CONCURRENTLY so uploads and the readers keep writing during the
-- build; the CLI that applies migrations runs it outside the migration's
-- transaction, and a half-built index left by a cancelled run is dropped first
-- (on a normal run the drop finds nothing). As in
-- 20261123004700_document_attachments_company_id_id_index, the timeout is
-- lifted for the build and restored after, and the drop gives up within
-- seconds instead of holding the table behind a long transaction.
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.

SET statement_timeout = 0;

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_document_attachments_backfill_walk;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_document_attachments_backfill_walk
  ON public.document_attachments (created_at DESC)
  INCLUDE (id, company_id, journal_entry_id, read_retry_after)
  WHERE pages_read_at IS NULL
    AND (mime_type IS NULL OR mime_type NOT IN ('application/xml', 'text/xml', 'application/json'));

RESET statement_timeout;
