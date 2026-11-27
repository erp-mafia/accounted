-- Validate after the transaction that installed the expanded CHECK releases its lock.
-- pg-test: covered-by tests/pg/pending-operations-op-type-audit.pg.test.ts
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;

NOTIFY pgrst, 'reload schema';
