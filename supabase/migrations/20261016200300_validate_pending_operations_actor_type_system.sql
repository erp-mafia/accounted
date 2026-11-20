-- Validate the actor type CHECK re-added in 20261016200200.
-- Separate transaction, as for the operation types (20261016200100).
-- pg-test: covered-by tests/pg/pending-operations-package-switches.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_actor_type_check;
