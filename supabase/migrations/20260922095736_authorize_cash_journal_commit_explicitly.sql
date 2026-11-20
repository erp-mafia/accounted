-- Authorize the definer explicitly before draft lookup or voucher allocation.
-- The company lock already checks the same permission. Keeping the check here
-- also removes the obsolete NULL-unsafe membership predicate from this RPC.
DO $migration$
DECLARE
  v_definition text := pg_get_functiondef('public.commit_journal_entry(uuid,uuid,text,text,text,text)'::regprocedure);
  v_old text := $old$  -- Tenant guard: anon/authenticated may only commit entries in their own
  -- companies; service_role / backend (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;$old$;
  v_new text := $new$  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;$new$;
BEGIN
  IF strpos(v_definition, v_old) = 0
     OR strpos(v_definition, 'PERFORM public.lock_cash_account_company(p_company_id);') = 0 THEN
    RAISE EXCEPTION 'CASH_COMMIT_AUTHORIZATION_DEFINITION_CHANGED';
  END IF;
  v_definition := replace(v_definition, v_old, v_new);
  v_definition := replace(v_definition,
    $declaration$  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
$declaration$, '');
  EXECUTE v_definition;
END;
$migration$;

NOTIFY pgrst, 'reload schema';
