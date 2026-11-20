-- pending_operations.operation_type: add mark_not_momsredovisning and
-- withdraw_not_momsredovisning, staged by gnubok_mark_not_momsredovisning and
-- gnubok_withdraw_not_momsredovisning (operations
-- vat-momsredovisning-marks.mark/.withdraw,
-- src/lib/operations/vat-momsredovisning-marks.ts, crm#1849): an agent proposes
-- the Moms page's "rättelse, inte momsredovisning" mark, or its withdrawal, and
-- a person approves it. Medium risk: nothing reaches the books, but the mark
-- changes what the momsdeklaration reads; withdrawing undoes it. Also
-- restates the comment on vat_momsredovisning_marks.actor for those approvals.
--
-- Same expand pattern as 20261108073617, with the list read from the
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
    'mark_not_momsredovisning',
    'withdraw_not_momsredovisning'
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

-- The actor of a mark is no longer only a web session's person: an approved
-- agent proposal records the person who approved it.
COMMENT ON COLUMN public.vat_momsredovisning_marks.actor IS
  'The person who marked or withdrew on the Moms page, or who approved an agent''s staged mark or withdrawal (gnubok_mark_not_momsredovisning, gnubok_withdraw_not_momsredovisning; approved in the chat, the API key''s owner). The server writes the row after the checks in lib/vat/momsredovisning-marks.ts.';

NOTIFY pgrst, 'reload schema';
