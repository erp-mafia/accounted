-- Validate the CHECKs re-added NOT VALID in 20261029210000: the parties
-- origin list and the pending_operations operation type list. Separate
-- transaction, as in 20261027120200: VALIDATE CONSTRAINT only reads the rows
-- under a lighter lock; nothing is rewritten.
-- pg-test: covered-by tests/pg/bolaget-registers.pg.test.ts

SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.parties
  VALIDATE CONSTRAINT parties_origin_check;

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;
