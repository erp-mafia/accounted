-- pending_operations.operation_type: the budget operations served over MCP
-- (src/lib/operations/budgets.ts, accounted#134): create, change and delete a
-- budget, save cells of its grid, copy last year's actuals into it and spread
-- a yearly amount over its months. All low risk: planning data, no booking.
--
-- Same expand pattern as 20260928202000, with the list read from the
-- constraint's current definition (the 20261028030547 form), so a type added
-- on another branch is never dropped. The CHECK only grows, so validating it
-- here reads the table once and can fail no row.
--
-- pg-test: covered-by tests/pg/pending-operations-op-type-audit.pg.test.ts

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
    'create_budget',
    'update_budget',
    'delete_budget',
    'upsert_budget_lines',
    'copy_budget_actuals',
    'spread_budget'
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
