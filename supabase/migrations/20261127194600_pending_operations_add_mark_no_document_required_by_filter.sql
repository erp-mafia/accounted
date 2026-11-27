-- pending_operations.operation_type: add mark_no_document_required_by_filter,
-- staged by gnubok_mark_no_document_required_by_filter (operation
-- journal-entries.filter-no-document-required,
-- src/lib/operations/journal-entries.ts): an agent proposes marking every
-- verifikat missing underlag in a period, series or date range "Inget
-- underlag krävs", the verifikat list's Markera alla utan underlag, and a
-- person approves it. Medium risk, as the id batch: only the sidecar table
-- journal_entry_no_doc_required is written, never a verifikat.
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
    'mark_no_document_required_by_filter'
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
