-- Stale application snapshots require new input, not a replay of the same
-- RPC. PostgREST 14 retries SQLSTATE 40001 indefinitely. PT409 gives callers
-- an immediate conflict and preserves the transaction rollback.
-- Only the four routines introduced by this bank-routing change are patched.
DO $$
DECLARE
  v_signature text;
  v_function regprocedure;
  v_definition text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.persist_bank_sync_result(uuid,uuid,text,timestamptz,timestamptz,jsonb,jsonb)',
    'public.resolve_bank_ingest_route(uuid,uuid,text,text,boolean)',
    'public.insert_bank_transaction(uuid,uuid,uuid,text,text,text,jsonb)',
    'public.bind_bank_transaction(uuid,uuid,text,text,text,uuid,date,numeric)'
  ] LOOP
    v_function := to_regprocedure(v_signature);
    IF v_function IS NULL THEN RAISE EXCEPTION 'Missing cash-account prerequisite: %', v_signature; END IF;
    v_definition := pg_get_functiondef(v_function);
    IF position(quote_literal('40001') IN v_definition) > 0 THEN
      EXECUTE replace(v_definition, quote_literal('40001'), quote_literal('PT409'));
    ELSIF position(quote_literal('PT409') IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Missing expected cash-account conflict: %', v_signature;
    END IF;
  END LOOP;
END;
$$;
NOTIFY pgrst, 'reload schema';
