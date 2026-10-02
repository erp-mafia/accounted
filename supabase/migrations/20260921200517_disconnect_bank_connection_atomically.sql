-- Disconnect releases both routing claims in one checked transaction. The
-- caller may claim an unused provider session only AFTER this RPC commits.
CREATE FUNCTION public.disconnect_bank_connection(
  p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_expected_token text
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_connection public.bank_connections;
  v_released integer;
BEGIN
  PERFORM public.lock_cash_account_company(p_company_id);
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid())
    OR NOT EXISTS (SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_user_id
      AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_DISCONNECT_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF p_expected_token IS DISTINCT FROM public.bank_configuration_token(p_company_id) THEN
    RAISE EXCEPTION 'BANK_CONFIGURATION_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  -- Preserve the cash row, primary flag, observations, ledger and all history.
  -- A failure of either write, including the provider-session guard, rolls
  -- this whole release back. No external call occurs within the transaction.
  UPDATE public.cash_accounts SET bank_connection_id = NULL, external_uid = NULL
  WHERE company_id = p_company_id AND bank_connection_id = p_connection_id;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  UPDATE public.bank_connections SET status = 'revoked', session_id = NULL,
    oauth_state = NULL, oauth_origin = NULL, authorization_id = NULL
  WHERE company_id = p_company_id AND id = p_connection_id;

  RETURN jsonb_build_object('connection_id', v_connection.id, 'session_id', v_connection.session_id,
    'bank_name', v_connection.bank_name, 'released_cash_accounts', v_released);
END;
$function$;
REVOKE ALL ON FUNCTION public.disconnect_bank_connection(uuid,uuid,uuid,text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.disconnect_bank_connection(uuid,uuid,uuid,text) TO authenticated, service_role;
NOTIFY pgrst, 'reload schema';
