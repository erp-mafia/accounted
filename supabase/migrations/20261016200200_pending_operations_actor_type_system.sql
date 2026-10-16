-- pending_operations.actor_type: add 'system', the actor of a suggestion.
-- A detector (src/lib/suggestions) stages a package switch on its own when an
-- event calls for it (the first employee registered, a till or webshop
-- connected): nobody asked for it, so the row names the system, labelled
-- "Accounted", the way audit_log, suggestion_log and journal_entries already
-- name it ('system' is in their lists since 20261016120100). Nothing is
-- committed by the system: every suggestion waits for a person's approval.
--
-- The constraint's current list plus 'system', read from the catalog as
-- 20261016200000 reads the operation types, so a branch that adds its own
-- actor type in parallel keeps it. NOT VALID; 20261016200300 validates it.
--
-- pg-test: tests/pg/pending-operations-package-switches.pg.test.ts

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
     AND c.conname = 'pending_operations_actor_type_check';
  -- user, api_key, mcp_oauth, cron, agent_chat, service_account at least.
  IF v_types IS NULL OR cardinality(v_types) < 6 THEN
    RAISE EXCEPTION 'pending_operations_actor_type_check: expected the full list, read % values', coalesce(cardinality(v_types), 0);
  END IF;
  IF NOT ('system' = ANY (v_types)) THEN
    v_types := v_types || 'system'::text;
  END IF;
  ALTER TABLE public.pending_operations DROP CONSTRAINT pending_operations_actor_type_check;
  EXECUTE format(
    'ALTER TABLE public.pending_operations ADD CONSTRAINT pending_operations_actor_type_check CHECK (actor_type IN (%s)) NOT VALID',
    (SELECT string_agg(quote_literal(t), ', ') FROM unnest(v_types) AS t)
  );
END;
$$;

NOTIFY pgrst, 'reload schema';
