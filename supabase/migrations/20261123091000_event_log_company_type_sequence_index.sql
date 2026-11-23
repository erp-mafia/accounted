-- event_log: one company's events of one type in sequence order, for the type
-- filter of the public event feed.
--
-- GET /api/events?types=... (app/api/events/route.ts) reads a company's events
-- of the named types after a cursor, oldest first, a page at a time. The only
-- index on company_id was (company_id, sequence): the read walked the
-- company's events in sequence order and dropped every other type, so a type
-- the company has few of meant reading all of its events. For the largest
-- event log in production (about 243 000 rows, nearly all MCP telemetry) a
-- filter on a type it has one event of read every row: 17 to 34 s, past the
-- 8 s statement timeout, so the request failed.
--
-- With this index an equality on company_id and event_type is one range in
-- sequence order, and the read stops after its page. The route reads each
-- named type with such an equality and merges the pages: an
-- `event_type = ANY (...)` filter, the form PostgREST sends for `in`, cannot
-- be served in sequence order by this index, and the planner still walks.
--
-- Built CONCURRENTLY so every emitted event keeps writing during the build;
-- the CLI that applies migrations runs it outside the migration's
-- transaction, and a half-built index left by a cancelled run is dropped
-- first (on a normal run the drop finds nothing).
--
-- pg-test: skip an index only; no trigger, RPC, policy or constraint changes.
--
-- event_log is about 2.4 GB (2.4 million rows). The build reads all of it,
-- and a concurrent build also waits for every transaction older than it, so
-- it can pass the migration connection's 2-minute statement_timeout. As in
-- 20261123004700_document_attachments_company_id_id_index, the migration
-- lifts the timeout for its own statements and restores it after, so a later
-- migration in the same push runs under the usual limit.

SET statement_timeout = 0;

-- The drop of a half-built index takes an exclusive lock on the table, and
-- with no statement timeout it could hold every event write behind a long
-- transaction. lock_timeout makes it give up within seconds instead, and the
-- run is retried. It is reset before the build: the build's waits for older
-- transactions are lock waits too. On a normal run the drop finds nothing and
-- takes no lock.
SET lock_timeout = '5s';

DROP INDEX IF EXISTS public.idx_event_log_company_type_sequence;

RESET lock_timeout;

CREATE INDEX CONCURRENTLY idx_event_log_company_type_sequence
  ON public.event_log (company_id, event_type, sequence);

RESET statement_timeout;
