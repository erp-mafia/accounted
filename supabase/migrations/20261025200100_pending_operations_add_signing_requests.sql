-- pending_operations.operation_type: the staged doors of BankID document
-- signing (lib/operations/signing-requests.ts): 'request_signature' (send an
-- archived PDF for signing) and 'remind_signature' (mail a pending signer
-- again).
--
-- Expanded from the constraint's current definition, read from the catalog
-- (the pattern of 20261022130100 and 20261023003000), never re-stated from a
-- copy, so no value main added is dropped again. Keep it in step with the
-- risk-tier table in lib/pending-operations/risk-tiers.ts. Validated right
-- away: the table is small enough that the scan is brief.
--
-- pg-test: covered-by tests/pg/signing-pending-types.pg.test.ts

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
  IF NOT ('request_signature' = ANY (v_types)) THEN
    v_types := v_types || 'request_signature'::text;
  END IF;
  IF NOT ('remind_signature' = ANY (v_types)) THEN
    v_types := v_types || 'remind_signature'::text;
  END IF;
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
