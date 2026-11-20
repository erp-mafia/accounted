-- pending_operations.operation_type: add the two collections bookings an
-- agent may stage (src/lib/operations/collections-booking.ts):
-- book_collected_payment (a payment a debtor made to the collections
-- provider, booked as the invoice's payment against the clearing account)
-- and book_collection_settlement (a payout from the provider as one voucher,
-- its lines and amount pinned at staging). Both are high risk and
-- approvable by an agent (bookings are obligation work, not escalations).
-- Keep them in step with the risk-tier table in
-- lib/pending-operations/risk-tiers.ts, which PendingOperationType derives
-- from.
--
-- Expanded from the constraint's current definition, read from the catalog
-- (the pattern of 20261015170000, main's latest restatement: 172 values,
-- request_payment_signature, confirm_supplier_payee and
-- cancel_quote_or_proforma included), never re-stated from a copy: a copy
-- taken before a value main added later would drop that value again in
-- production. NOT VALID; the VALIDATE runs in 20261021120500.
--
-- pg-test: tests/pg/pending-operations-op-type-audit.pg.test.ts.
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
  FOREACH v_new IN ARRAY ARRAY['book_collected_payment', 'book_collection_settlement']::text[] LOOP
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
