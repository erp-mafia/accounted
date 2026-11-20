-- The account-erasure definer revokes its user's consents after deleting
-- memberships. Preserve that existing capability without making routing writes
-- available to callers who cannot execute the private erasure helper.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.guard_bank_configuration_writer()'::regprocedure);
  v_old text := $old$BEGIN
  IF TG_OP = 'UPDATE' THEN$old$;
  v_new text := $new$BEGIN
  IF TG_OP = 'UPDATE' AND TG_TABLE_NAME = 'bank_connections' THEN
    IF has_function_privilege(current_user, 'public.erase_user_personal_data(uuid)', 'EXECUTE')
       AND NEW.status = 'revoked'
       AND NEW.session_id IS NULL
       AND NEW.authorization_id IS NULL
       AND NEW.oauth_state IS NULL
       AND NEW.accounts_data IS NULL
       AND (to_jsonb(NEW) - ARRAY['status','session_id','authorization_id','oauth_state','accounts_data','updated_at'])
         = (to_jsonb(OLD) - ARRAY['status','session_id','authorization_id','oauth_state','accounts_data','updated_at']) THEN
      -- The protected caller already authorized erasure. Keep the same
      -- company coordination, including after membership removal and for an
      -- archived company, but never wait while holding a connection row.
      BEGIN
        PERFORM 1 FROM public.companies WHERE id = NEW.company_id FOR NO KEY UPDATE NOWAIT;
        IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
      EXCEPTION WHEN lock_not_available THEN
        RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
      END;
      RETURN NEW;
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN$new$;
BEGIN
  IF strpos(v_definition, v_old) = 0
     OR strpos(v_definition, 'PERFORM public.lock_cash_account_company(v_company, false);') = 0 THEN
    RAISE EXCEPTION 'BANK_CONFIGURATION_GUARD_DEFINITION_CHANGED';
  END IF;
  EXECUTE replace(v_definition, v_old, v_new);
END;
$migration$;

NOTIFY pgrst, 'reload schema';
