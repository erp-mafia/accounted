-- pending_operations.operation_type: add prepare_salary_payment_orders,
-- staged by gnubok_prepare_salary_payments (operation
-- salary-runs.prepare-bank-payment, src/lib/operations/salary-run-bank-payment.ts):
-- an agent proposes paying a salary run's net pay through the bank, and a
-- person approves it. The approval only creates draft payment orders, one
-- per employee; a person approves them and signs with BankID on Betalningar,
-- as for supplier payments. Medium risk, like prepare_payment_orders.
--
-- Same expand pattern as 20261125150000, with the list read from the
-- constraint's current definition, so a type added on another branch is
-- never dropped. The CHECK only grows, so validating it here reads the table
-- once and can fail no row. It is validated, as after every earlier
-- expansion: the pg-real suite asserts convalidated on this constraint.
--
-- pg-test: covered-by tests/pg/pending-operations-op-type-audit.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

DO $$
DECLARE
  v_types text[];
  v_new text;
BEGIN
  SELECT array_agg(DISTINCT m[1] ORDER BY m[1])
    INTO v_types
    FROM pg_constraint c,
         LATERAL regexp_matches(pg_get_constraintdef(c.oid), '''([a-z0-9_]+)''', 'g') AS m
   WHERE c.conrelid = 'public.pending_operations'::regclass
     AND c.conname = 'pending_operations_operation_type_check';
  IF v_types IS NULL OR cardinality(v_types) < 150 THEN
    RAISE EXCEPTION 'pending_operations_operation_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  FOREACH v_new IN ARRAY ARRAY[
    'prepare_salary_payment_orders'
  ] LOOP
    IF NOT (v_new = ANY (v_types)) THEN
      v_types := v_types || v_new;
    END IF;
  END LOOP;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

ALTER TABLE public.pending_operations
  VALIDATE CONSTRAINT pending_operations_operation_type_check;

NOTIFY pgrst, 'reload schema';
