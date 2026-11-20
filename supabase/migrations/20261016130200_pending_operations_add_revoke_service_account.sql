-- pending_operations.operation_type: add revoke_service_account, the staged
-- MCP tool gnubok_revoke_service_account. An agent proposes revoking one of
-- the company's service accounts (lib/service-accounts); an owner or admin
-- approves it in Att göra or with gnubok_approve_pending_operation, and the
-- commit runs revoke_service_account (20261016120000), which re-checks that
-- the approver is an owner or admin and revokes the account's keys with it.
-- High risk: the revocation is final. Expanded from the constraint's current
-- definition (below), NOT VALID; the VALIDATE runs in 20261016130300. Every
-- later migration that rebuilds this list keeps this value, or it drops it
-- again (tests/pg/pending-operations-op-type-audit.pg.test.ts catches that).
--
-- pg-test: tests/pg/pending-operations-revoke-service-account.pg.test.ts

-- pending_operations is written on every staging and approval: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

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
  IF NOT ('revoke_service_account' = ANY (v_types)) THEN
    v_types := v_types || 'revoke_service_account'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_operation_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_operation_type_check CHECK (operation_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
