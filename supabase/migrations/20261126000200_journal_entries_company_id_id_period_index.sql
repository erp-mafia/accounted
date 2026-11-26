-- journal_entries: a company's vouchers in id order with their period, for
-- the read backfill's period test.
--
-- document_backfill_candidates tests every unread document it walks against
-- the period of its voucher (enforce_period_lock_documents refuses the stamp
-- on a closed or locked period), and on a run with little to read that is the
-- voucher of every unread document. It read each one by primary key: voucher
-- ids are random, so the walk's vouchers sat on index pages spread over the
-- whole primary key, each one followed by a visit to the table for
-- fiscal_period_id. A run whose pages were no longer in memory read most of
-- them from disk and passed the 8 s statement timeout.
--
-- In this index one company's vouchers sit next to each other, and the period
-- is in the index, so the test reads a few pages per company and never the
-- table for a voucher on a page vacuum has marked all-visible. The function
-- looks the voucher up by (company_id, id)
-- (20261126000300_document_backfill_candidates_index_only).
--
-- Its key is idx_journal_entries_company_id_id's, so it serves every read that
-- index serves; dropping the narrower one is left to a later change.
--
-- Built CONCURRENTLY so bookkeeping keeps writing during the build; the CLI
-- that applies migrations runs it outside the migration's transaction, and a
-- half-built index left by a cancelled run is dropped first (on a normal run
-- the drop finds nothing). As in
-- 20261123004700_document_attachments_company_id_id_index, the timeout is
-- lifted for the build and restored after, and the drop gives up within
-- seconds instead of holding the table behind a long transaction.
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.

SET statement_timeout = 0;

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_journal_entries_company_id_id_period;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_journal_entries_company_id_id_period
  ON public.journal_entries (company_id, id)
  INCLUDE (fiscal_period_id);

RESET statement_timeout;
