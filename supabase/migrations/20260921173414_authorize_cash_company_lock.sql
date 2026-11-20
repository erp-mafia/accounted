-- Direct SQL role contexts may lack the whole JWT claims object. Keep the
-- narrow company-lock helper tenant-checked for those authenticated callers.
CREATE OR REPLACE FUNCTION public.lock_cash_account_company(p_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (public.jwt_caller_is_end_user()
      OR current_setting('role', true) IN ('authenticated', 'anon')
      OR auth.uid() IS NOT NULL)
     AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
END;
$$;
