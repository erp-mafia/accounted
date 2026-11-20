-- pending_operations.operation_type: add enable_package and disable_package,
-- the staged package switches of the Profiles and Suggestions design (step 3).
-- A detector stages one as a suggestion (src/lib/suggestions), a person or
-- the customer's agent approves it in Att göra, /pending, the v1 approve
-- endpoint or gnubok_approve_pending_operation, and the commit writes the
-- company's choice for the package (company_capability_config, key
-- package:<id>) through set_company_package_choice (20261016200400).
-- disable_package refuses while the package has open obligations.
-- Low risk: no booking impact, and either switch is undone by the other.
-- Expanded from the constraint's current definition (below), NOT VALID; the
-- VALIDATE runs in 20261016200100. Every later migration that rebuilds this
-- list keeps these values, or it drops them again
-- (tests/pg/pending-operations-op-type-audit.pg.test.ts catches that).
--
-- pg-test: tests/pg/pending-operations-package-switches.pg.test.ts

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
  FOREACH v_new IN ARRAY ARRAY['enable_package', 'disable_package'] LOOP
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
