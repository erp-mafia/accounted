-- pending_operations.operation_type: add cancel_quote_or_proforma, the staged
-- MCP tool gnubok_cancel_quote_or_proforma (src/lib/operations/
-- invoice-cancel.ts, accounted#20): makulera a quote or a proforma invoice.
-- Low risk: neither document carries a verifikat and the row survives as
-- cancelled. Expanded from the constraint's current definition (below),
-- NOT VALID; the VALIDATE runs in 20261015170100. Every later migration that
-- rebuilds this list keeps this value, or it drops it again
-- (tests/pg/pending-operations-op-type-audit.pg.test.ts catches that).
--
-- pg-test: tests/pg/pending-operations-cancel-quote-or-proforma.pg.test.ts.

-- The constraint's own current list plus this value, read from the catalog
-- rather than re-stated from a copy: a branch that adds its own value in
-- parallel keeps it, in whichever order the two migrations run.
DO $$
DECLARE
  v_types text[];
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
  IF NOT ('cancel_quote_or_proforma' = ANY (v_types)) THEN
    v_types := v_types || 'cancel_quote_or_proforma'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
