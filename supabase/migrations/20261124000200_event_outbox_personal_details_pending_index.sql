-- event_outbox: the events whose payload still holds personal details.
--
-- remove_event_personal_details (20261124000000) takes them oldest first,
-- each night those that turned 30 days old and have no delivery left to run.
-- The outbox keeps every event, so without this index the batch would read
-- past every event already done, a number that only grows. The index holds
-- the rows still to do: about the last 30 days. The predicate is the batch's
-- own.
--
-- Built CONCURRENTLY so enqueue_event keeps writing during the build; the CLI
-- that applies migrations runs it outside the migration's transaction, and a
-- half-built index left by a cancelled run is dropped first (on a normal run
-- the drop finds nothing). As in
-- 20261123093000_document_jobs_open_by_company_index, the timeout is lifted
-- for the build and restored after, and the drop gives up within seconds
-- instead of holding the table behind a long transaction.
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.

SET statement_timeout = 0;

SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_event_outbox_personal_details_pending;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_event_outbox_personal_details_pending
  ON public.event_outbox (created_at)
  WHERE personal_details_removed_at IS NULL;

RESET statement_timeout;
