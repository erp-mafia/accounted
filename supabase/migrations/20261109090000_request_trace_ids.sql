-- The trace id of the request that wrote a row, on the three tables a staged
-- write leaves behind:
--
--   * pending_operations.trace_id: the request that staged the operation (an
--     MCP tool call, a REST v1 ?stage=true write, a cron batch).
--   * business_events.trace_id: the request whose posting recorded the event,
--     usually the approval that committed the staged operation.
--   * suggestion_log.trace_id: the request that recorded the decision receipt.
--
-- These rows are linked to each other already (pending_operation_id); the
-- trace id links each of them to the request that wrote it, and through it to
-- that request's log lines and its mcp.tool_called event_log row (whose
-- payload carries the same trace id as traceId). One query can then follow
-- one request across its rows.
--
-- The value is a W3C Trace Context trace-id: 32 lowercase hex characters,
-- taken from a valid inbound `traceparent` (the HTTP header, or an MCP
-- request's params._meta.traceparent) or minted by the server
-- (src/lib/observability/trace-context.ts). A client-supplied id is a
-- correlation hint, never an identity or an authorization input. NULL when
-- the write ran outside a request scope, and on every row written before this
-- migration (no backfill).
--
-- Trigger review: nothing here changes a trigger, function or policy, and no
-- trigger on these tables reads a column list that a new nullable column
-- would break:
--   * pending_operations: enforce_pending_operations_input_frozen freezes
--     params / operation_type / preview_data only; the terminal-state
--     blockers (pending_operations_immutability, pending_operations_no_delete,
--     20260722134114) and pending_operations_sync_suggestion key on status;
--     the batch insert guards (guard_collections_batch_insert,
--     guard_reminder_batch_insert) check the writing role only.
--   * business_events and suggestion_log: append-only on UPDATE and DELETE
--     (business_events_append_only, suggestion_log_append_only); the INSERT
--     triggers (enforce_company_writer_role,
--     block_migration_reset_source_mutation) read company_id only.
-- All three tables grant INSERT at table level, so the new column is covered
-- by the existing grants and policies. The value is set in the INSERT and
-- never updated.
--
-- Deploy order: the code may go live before this migration runs (it applies
-- after the merge, sometimes much later). The writers name trace_id only
-- when they have one and write again without it on PGRST204
-- (src/lib/observability/trace-column.ts), so a missing column never fails a
-- write.
--
-- Locks (prod 2026-11-09: pending_operations ~90k rows, 120 MB heap;
-- suggestion_log ~33k rows, 35 MB; business_events ~30k rows, 11 MB; a full
-- heap scan of each measured 70 to 320 ms):
--   * ADD COLUMN without a default is a catalog change; it does not rewrite.
--   * The CHECKs are NOT VALID: every existing row is NULL, so a validation
--     scan under the ALTER's ACCESS EXCLUSIVE lock would prove nothing. New
--     and updated rows are checked all the same.
--   * The indexes are plain CREATE INDEX: migrations run in a transaction,
--     where CONCURRENTLY is refused (precedent 20260706120000). Each build
--     scans its table once and stores nothing (every row is NULL today).
--   * Everything runs in one transaction, so each table stays locked from its
--     ALTER until the commit: the largest table goes last, locked shortest.
--   * lock_timeout fails the job fast instead of queueing every write behind
--     a long transaction; the next pipeline retries.
--
-- pg-test: tests/pg/request-trace-ids.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.business_events
  ADD COLUMN trace_id text,
  ADD CONSTRAINT business_events_trace_id_format
    CHECK (trace_id ~ '^[0-9a-f]{32}$') NOT VALID;

COMMENT ON COLUMN public.business_events.trace_id IS
  'W3C trace-id (32 lowercase hex) of the request that recorded the event. NULL outside a request scope and on rows written before it was recorded.';

-- Lookups are per company and trace; history carries none.
CREATE INDEX idx_business_events_company_trace
  ON public.business_events (company_id, trace_id)
  WHERE trace_id IS NOT NULL;

ALTER TABLE public.suggestion_log
  ADD COLUMN trace_id text,
  ADD CONSTRAINT suggestion_log_trace_id_format
    CHECK (trace_id ~ '^[0-9a-f]{32}$') NOT VALID;

COMMENT ON COLUMN public.suggestion_log.trace_id IS
  'W3C trace-id (32 lowercase hex) of the request that recorded the decision. NULL outside a request scope and on rows written before it was recorded.';

CREATE INDEX idx_suggestion_log_company_trace
  ON public.suggestion_log (company_id, trace_id)
  WHERE trace_id IS NOT NULL;

ALTER TABLE public.pending_operations
  ADD COLUMN trace_id text,
  ADD CONSTRAINT pending_operations_trace_id_format
    CHECK (trace_id ~ '^[0-9a-f]{32}$') NOT VALID;

COMMENT ON COLUMN public.pending_operations.trace_id IS
  'W3C trace-id (32 lowercase hex) of the request that staged the operation. NULL outside a request scope and on rows written before it was recorded.';

CREATE INDEX idx_pending_operations_company_trace
  ON public.pending_operations (company_id, trace_id)
  WHERE trace_id IS NOT NULL;

NOTIFY pgrst, 'reload schema';
