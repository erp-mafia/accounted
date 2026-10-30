-- pending_operations.operation_type: add the K3 staged operations
-- (lib/operations/k3.ts, accounted#111): a nedskrivning, a component
-- replacement, a building's tax plan, the split at the transition to K3, the
-- deferred tax inputs, the 18.7 model, and the transition's start, update,
-- removal and commit. Expanded from the constraint's current definition,
-- NOT VALID; the VALIDATE runs in 20261031201303. Every later migration that
-- rebuilds this list keeps these values, or it drops them again
-- (tests/pg/pending-operations-op-type-audit.pg.test.ts catches that).
--
-- pg-test: covered-by tests/pg/pending-operations-op-type-audit.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

-- The constraint's own current list plus these values, read from the catalog
-- rather than re-stated from a copy: a branch that adds its own value in
-- parallel keeps it, in whichever order the two migrations run.
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
    'post_asset_value_adjustment',
    'replace_asset_component',
    'set_asset_tax_plan',
    'set_asset_transition_split',
    'save_deferred_tax_inputs',
    'update_accounting_policies',
    'start_k3_transition',
    'update_k3_transition',
    'delete_k3_transition',
    'commit_k3_transition'
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

NOTIFY pgrst, 'reload schema';
