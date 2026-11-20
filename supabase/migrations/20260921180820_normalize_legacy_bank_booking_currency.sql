-- Legacy imported transactions can have NULL currency. Existing bulk booking
-- treats that value as SEK. Keep the same meaning in capture and commit checks.
DO $migration$
DECLARE
  v_signature text;
  v_definition text;
BEGIN
  FOREACH v_signature IN ARRAY ARRAY[
    'public.capture_bank_booking_context(uuid,uuid[])',
    'public.guard_bank_booking_context()'
  ] LOOP
    v_definition := pg_get_functiondef(v_signature::regprocedure);
    IF position('v_transaction.currency' IN v_definition) = 0 THEN
      RAISE EXCEPTION 'Unexpected bank booking currency definition: %', v_signature;
    END IF;
    v_definition := replace(v_definition, 'v_transaction.currency', 'COALESCE(v_transaction.currency, ''SEK'')');
    EXECUTE v_definition;
  END LOOP;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
