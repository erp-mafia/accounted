-- Keep the current predicate, including operations added by other branches.
-- pg-test: covered-by tests/pg/pending-operations-op-type-audit.pg.test.ts
SELECT set_config('lock_timeout', '5s', true);

DO $$
DECLARE
  current_check text;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO STRICT current_check
    FROM pg_constraint
   WHERE conrelid = 'public.pending_operations'::regclass
     AND conname = 'pending_operations_operation_type_check'
     AND contype = 'c';

  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK ((%s) OR operation_type = %L) NOT VALID',
    current_check, 'create_self_billed_invoice'
  );
END;
$$;
