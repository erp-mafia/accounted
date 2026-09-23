-- A drifted staging branch can lack the private erasure helper. Absence must
-- leave the ordinary authorization path in force, never break all updates.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.guard_bank_configuration_writer()'::regprocedure);
  v_old text := $old$has_function_privilege(current_user, 'public.erase_user_personal_data(uuid)', 'EXECUTE')$old$;
  v_new text := $new$coalesce(has_function_privilege(current_user, to_regprocedure('public.erase_user_personal_data(uuid)')::oid, 'EXECUTE'), false)$new$;
BEGIN
  IF strpos(v_definition, v_old) = 0 THEN
    RAISE EXCEPTION 'BANK_ERASURE_PRIVILEGE_CHECK_CHANGED';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
