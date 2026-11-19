-- The board signs the årsredovisning with BankID in Accounted
-- (lib/bokslut/arsredovisning/bankid-signing.ts): a signing request over the
-- version's e-signing copy, one signer per slot, and each signature fills
-- its slot through record_signing_signature (20261025200000).
--
-- 1. 'bankid' on a signature slot is our own BankID evidence only. Until
--    now any caller could record signing_method 'bankid' by hand with no
--    signature behind it; record-signature refuses it now
--    (SIGNING_METHOD_RESERVED), and this CHECK keeps the database to the same
--    rule: a 'bankid' slot carries the signing request's ids in
--    bankid_signature_data, which only record_signing_signature writes. NOT
--    VALID: the one slot recorded by hand before this change keeps its
--    history (signed slots are frozen and never rewritten); every new write
--    is checked. A NULL bankid_signature_data does not pass (IS NOT NULL).
-- 2. pending_operations.operation_type: 'request_arsredovisning_signatures',
--    the staged MCP door of the board's signing.
--
-- pg-test: covered-by tests/pg/arsredovisning-bankid-signing.pg.test.ts

ALTER TABLE public.arsredovisning_signature_requests
  ADD CONSTRAINT arsredovisning_signature_bankid_is_recorded_signing CHECK (
    signing_method IS DISTINCT FROM 'bankid'
    OR (
      bankid_signature_data IS NOT NULL
      AND jsonb_typeof(bankid_signature_data) = 'object'
      AND bankid_signature_data ? 'signing_signer_id'
      AND bankid_signature_data ? 'signing_request_id'
    )
  ) NOT VALID;

-- Expanded from the constraint's current definition, read from the catalog
-- (the pattern of 20261022130100 and 20261023003000), never re-stated from a
-- copy. Keep it in step with lib/pending-operations/risk-tiers.ts.
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
  IF NOT ('request_arsredovisning_signatures' = ANY (v_types)) THEN
    v_types := v_types || 'request_arsredovisning_signatures'::text;
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
