-- Validate the actor-type CHECKs re-added NOT VALID in 20261016120100.
-- Separate transaction: avoids a full-table scan under the stronger lock of
-- the preceding migration (same split as 20261015180100). VALIDATE CONSTRAINT
-- only reads the rows; nothing is rewritten.
-- pg-test: covered-by tests/pg/service-accounts.pg.test.ts

-- Hot tables (journal_entries, api_keys, audit_log, ...): never queue every
-- write behind a long transaction. Fail the migration job instead and retry.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.journal_entries
  VALIDATE CONSTRAINT journal_entries_committed_actor_type_check;
ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_actor_type_check;
ALTER TABLE public.audit_log
  VALIDATE CONSTRAINT audit_log_actor_type_check;
ALTER TABLE public.suggestion_log
  VALIDATE CONSTRAINT suggestion_log_actor_type_check;
ALTER TABLE public.journal_entry_rattelse_log
  VALIDATE CONSTRAINT journal_entry_rattelse_log_actor_type_check;
ALTER TABLE public.sie_imports
  VALIDATE CONSTRAINT sie_imports_undo_actor_type_check;
