-- The bank request carries this route snapshot until its rows are persisted.
-- Balance observations do not affect the token. Session, UID, selection,
-- physical identity and destination changes invalidate it.
CREATE FUNCTION public.resolve_bank_ingest_route(
  p_company_id uuid,
  p_connection_id uuid,
  p_account_uid text,
  p_currency text,
  p_lock boolean DEFAULT false
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_connection public.bank_connections;
  v_cash public.cash_accounts;
  v_account jsonb;
  v_token text;
BEGIN
  IF p_lock THEN
    SELECT * INTO v_connection FROM public.bank_connections
     WHERE company_id = p_company_id AND id = p_connection_id FOR SHARE;
  ELSE
    SELECT * INTO v_connection FROM public.bank_connections
     WHERE company_id = p_company_id AND id = p_connection_id;
  END IF;
  IF v_connection.id IS NULL OR v_connection.status IS NULL
     OR v_connection.status NOT IN ('active', 'error') OR v_connection.superseded_by IS NOT NULL
     OR nullif(v_connection.session_id, '') IS NULL THEN
    RAISE EXCEPTION 'BANK_INGEST_CONNECTION_CHANGED' USING ERRCODE = '40001';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) a
       WHERE a->>'uid' = p_account_uid) <> 1 THEN
    RAISE EXCEPTION 'BANK_INGEST_ACCOUNT_CHANGED' USING ERRCODE = '40001';
  END IF;
  SELECT value INTO v_account FROM jsonb_array_elements(v_connection.accounts_data)
   WHERE value->>'uid' = p_account_uid;
  IF coalesce((v_account->>'enabled')::boolean, true) IS NOT TRUE
     OR upper(v_account->>'currency') IS DISTINCT FROM upper(p_currency) THEN
    RAISE EXCEPTION 'BANK_INGEST_ACCOUNT_CHANGED' USING ERRCODE = '40001';
  END IF;
  IF p_lock THEN
    SELECT * INTO v_cash FROM public.cash_accounts
     WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
       AND external_uid = p_account_uid FOR SHARE;
  ELSE
    SELECT * INTO v_cash FROM public.cash_accounts
     WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
       AND external_uid = p_account_uid;
  END IF;
  IF v_cash.id IS NULL OR v_cash.enabled IS NOT TRUE
     OR upper(v_cash.currency) IS DISTINCT FROM upper(p_currency)
     OR v_account->>'ledger_account' IS DISTINCT FROM v_cash.ledger_account THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_UNRESOLVED' USING ERRCODE = '40001';
  END IF;
  -- A matching ledger is insufficient when the account identity itself drifted.
  IF nullif(regexp_replace(v_account->>'iban', '\s', '', 'g'), '') IS NOT NULL
     AND upper(regexp_replace(v_account->>'iban', '\s', '', 'g'))
       IS DISTINCT FROM upper(regexp_replace(v_cash.iban, '\s', '', 'g')) THEN
    RAISE EXCEPTION 'BANK_INGEST_IDENTITY_CHANGED' USING ERRCODE = '40001';
  END IF;
  v_token := md5(jsonb_build_array('bank-route-v1', p_company_id, v_connection.id,
    v_connection.session_id, p_account_uid, v_cash.id, v_cash.ledger_account,
    upper(v_cash.currency), upper(regexp_replace(v_cash.iban, '\s', '', 'g')),
    v_cash.bban, v_cash.enabled, v_account->>'enabled')::text);
  RETURN jsonb_build_object('connectionId', v_connection.id, 'sessionId', v_connection.session_id,
    'accountUid', p_account_uid, 'cashAccountId', v_cash.id, 'ledgerAccount', v_cash.ledger_account,
    'currency', upper(v_cash.currency), 'token', v_token);
END;
$$;

CREATE FUNCTION public.insert_bank_transaction(
  p_company_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_account_uid text,
  p_currency text,
  p_route_token text,
  p_transaction jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_route jsonb;
  v_input public.transactions;
  v_transaction public.transactions;
BEGIN
  v_route := public.resolve_bank_ingest_route(p_company_id, p_connection_id, p_account_uid, p_currency, true);
  IF p_route_token IS DISTINCT FROM v_route->>'token' THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_CHANGED' USING ERRCODE = '40001';
  END IF;
  IF auth.role() = 'authenticated' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'BANK_INGEST_ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_transaction) IS DISTINCT FROM 'object'
     OR upper(p_transaction->>'currency') IS DISTINCT FROM upper(p_currency) THEN
    RAISE EXCEPTION 'BANK_INGEST_TRANSACTION_INVALID' USING ERRCODE = '22023';
  END IF;
  v_input := jsonb_populate_record(NULL::public.transactions, p_transaction);
  -- Only source fields may enter this boundary. Company, actor and destination
  -- come from checked context; callers cannot inject a journal/invoice anchor.
  INSERT INTO public.transactions(
    company_id, user_id, bank_connection_id, cash_account_id, external_id, date,
    description, original_description, transaction_method, bank_transaction_code,
    proprietary_bank_transaction_code, amount, currency, amount_sek, exchange_rate,
    exchange_rate_date, category, is_business, mcc_code, merchant_name, reference,
    import_source, counterparty_iban, counterparty_account
  ) VALUES (
    p_company_id, p_user_id, p_connection_id, (v_route->>'cashAccountId')::uuid,
    v_input.external_id, v_input.date, v_input.description, v_input.original_description,
    v_input.transaction_method, v_input.bank_transaction_code, v_input.proprietary_bank_transaction_code,
    v_input.amount, upper(p_currency), v_input.amount_sek, v_input.exchange_rate,
    v_input.exchange_rate_date, 'uncategorized', NULL, v_input.mcc_code,
    v_input.merchant_name, v_input.reference, 'enable_banking',
    v_input.counterparty_iban, v_input.counterparty_account
  ) RETURNING * INTO v_transaction;
  RETURN to_jsonb(v_transaction);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.resolve_bank_ingest_route(uuid, uuid, text, text, boolean) FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION public.insert_bank_transaction(uuid, uuid, uuid, text, text, text, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_bank_ingest_route(uuid, uuid, text, text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.insert_bank_transaction(uuid, uuid, uuid, text, text, text, jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
