-- Validate the operation type CHECK re-added in 20261127161400.
-- Separate transaction: avoids a full-table scan under the stronger lock of
-- the preceding migration (same split as 20261016200100). VALIDATE CONSTRAINT
-- only reads the rows; nothing is rewritten.
-- pg-test: covered-by tests/pg/spend-expenses.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
