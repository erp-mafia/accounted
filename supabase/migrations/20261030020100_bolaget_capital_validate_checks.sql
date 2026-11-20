-- Validate the pending_operations operation type CHECK re-added NOT VALID in
-- 20261030020000. Separate transaction, as in 20261029210100: VALIDATE
-- CONSTRAINT only reads the rows under a lighter lock; nothing is rewritten.
-- pg-test: covered-by tests/pg/capital-events.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
