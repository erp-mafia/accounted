-- Stale application snapshots require new input, not a replay of the same
-- RPC. PostgREST 14 retries SQLSTATE 40001 indefinitely. PT409 gives callers
-- an immediate conflict and preserves the transaction rollback.
-- Only the three routines introduced by this cash-account change are patched.
DO $$
DECLARE
  v_signature text;
  v_function regprocedure;
  v_definition text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.guard_bank_booking_context()',
    'public.promote_psd2_cash_account(uuid,jsonb,uuid[])',
    'public.heal_cash_account_twins(uuid,text,uuid,jsonb)'
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
