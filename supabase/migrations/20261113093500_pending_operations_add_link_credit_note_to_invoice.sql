-- pending_operations.operation_type: add link_credit_note_to_invoice, the
-- staged operation invoices.link-credit-note (src/lib/operations/
-- invoice-credit-link.ts, crm#1852): an existing credit note linked to the
-- existing invoice it credits, kundreskontra only, no verifikat.
--
-- Same expand pattern as 20261109170310, with the list read from the
-- constraint's current definition, so a type added on another branch is
-- never dropped. The CHECK only grows, so validating it here reads the table
-- once and can fail no row.
--
-- pg-test: covered-by tests/pg/pending-operations-op-type-audit.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

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
  IF NOT ('link_credit_note_to_invoice' = ANY (v_types)) THEN
    v_types := v_types || 'link_credit_note_to_invoice'::text;
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
