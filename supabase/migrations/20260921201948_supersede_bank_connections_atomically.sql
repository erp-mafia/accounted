-- One company transition replaces the old park/repoint/release/cursor HTTP
-- sequence. Provider revocation runs only after this transaction commits.
CREATE FUNCTION public.supersede_bank_connections(
  p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_expected_token text,
  p_expected_session_id text, p_preserve_scope_uids text[] DEFAULT '{}'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_survivor public.bank_connections; v_donor public.bank_connections;
  v_ids uuid[]; v_superseded jsonb; v_next jsonb := '[]'; v_account jsonb;
  v_iban text; v_currency text; v_scopes text[]; v_last_synced timestamptz;
  v_moved integer; v_released integer;
BEGIN
  PERFORM public.lock_cash_account_company(p_company_id);
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid())
    OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_user_id
      AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_SUPERSEDE_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_survivor FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF p_expected_token IS DISTINCT FROM public.bank_configuration_token(p_company_id)
    OR p_expected_session_id IS NULL OR v_survivor.session_id IS DISTINCT FROM p_expected_session_id
    OR v_survivor.status NOT IN ('active','pending_selection') OR v_survivor.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_CONFIGURATION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_preserve_scope_uids) uid WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_survivor.accounts_data) a WHERE a->>'uid' = uid)) THEN
    RAISE EXCEPTION 'BANK_SUPERSEDE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Keep the existing no-IBAN fallback only for non-active rows when neither
  -- side has any IBAN. Otherwise require matching physical account/currency;
  -- separate active logins at the same bank must remain separate.
  SELECT coalesce(array_agg(b.id ORDER BY b.id),'{}'),
    coalesce(jsonb_agg(jsonb_build_object('id',b.id,'session_id',b.session_id) ORDER BY b.id),'[]')
    INTO v_ids,v_superseded
  FROM public.bank_connections b
  WHERE b.company_id = p_company_id AND b.id <> p_connection_id
    AND b.bank_name = v_survivor.bank_name AND b.provider = v_survivor.provider
    AND b.status IN ('active','expired','error','pending_selection') AND b.superseded_by IS NULL
    AND (EXISTS(SELECT 1 FROM jsonb_array_elements(b.accounts_data) old_account,
      jsonb_array_elements(v_survivor.accounts_data) new_account
      WHERE nullif(upper(regexp_replace(old_account->>'iban','\s','','g')),'')
        = nullif(upper(regexp_replace(new_account->>'iban','\s','','g')),'')
      AND upper(coalesce(nullif(old_account->>'currency',''),'SEK')) = upper(coalesce(nullif(new_account->>'currency',''),'SEK')))
    OR (b.status <> 'active'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.accounts_data) a WHERE nullif(regexp_replace(a->>'iban','\s','','g'),'') IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_survivor.accounts_data) a WHERE nullif(regexp_replace(a->>'iban','\s','','g'),'') IS NOT NULL)));
  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('superseded','[]'::jsonb,'accounts',coalesce(v_survivor.accounts_data,'[]'),
      'moved_transactions',0,'released_cash_accounts',0);
  END IF;
  PERFORM 1 FROM public.transactions WHERE company_id = p_company_id AND bank_connection_id = ANY(v_ids) ORDER BY id FOR UPDATE;

  -- Carry only explicit legacy scopes, as before. A survivor's existing
  -- explicit scope wins. Currency is part of identity so scopes cannot leak
  -- between resources which happen to share an IBAN. Conflicting donors
  -- require review; arbitrary row order must not determine future IDs.
  FOR v_account IN SELECT value FROM jsonb_array_elements(v_survivor.accounts_data) LOOP
    v_iban := nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'');
    v_currency := upper(coalesce(nullif(v_account->>'currency',''),'SEK'));
    IF v_iban IS NOT NULL AND NOT (v_account->>'uid' = ANY(coalesce(p_preserve_scope_uids,'{}')))
      AND (nullif(v_account->>'dedup_scope','') IS NULL OR v_account->>'dedup_scope' IN (v_iban,v_account->>'uid')) THEN
      SELECT array_agg(DISTINCT a->>'dedup_scope' ORDER BY a->>'dedup_scope') INTO v_scopes
      FROM public.bank_connections b CROSS JOIN LATERAL jsonb_array_elements(b.accounts_data) a
      WHERE b.company_id = p_company_id AND b.id = ANY(v_ids)
        AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban
        AND upper(coalesce(nullif(a->>'currency',''),'SEK')) = v_currency AND nullif(a->>'dedup_scope','') IS NOT NULL;
      IF cardinality(v_scopes) > 1 THEN
        RAISE EXCEPTION 'BANK_SUPERSEDE_SCOPE_AMBIGUOUS' USING ERRCODE = 'PT409';
      END IF;
      IF cardinality(v_scopes) = 1 THEN
        v_account := v_account || jsonb_build_object('dedup_scope',v_scopes[1]);
      END IF;
    END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;

  SELECT max(last_synced_at) INTO v_last_synced FROM public.bank_connections WHERE company_id = p_company_id AND id = ANY(v_ids);
  SELECT * INTO v_donor FROM public.bank_connections WHERE company_id = p_company_id AND id = ANY(v_ids)
    AND initial_sync_completed_at IS NOT NULL ORDER BY initial_sync_completed_at DESC,id LIMIT 1;

  UPDATE public.transactions SET bank_connection_id = p_connection_id
    WHERE company_id = p_company_id AND bank_connection_id = ANY(v_ids);
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  UPDATE public.cash_accounts SET bank_connection_id = NULL, external_uid = NULL
    WHERE company_id = p_company_id AND bank_connection_id = ANY(v_ids);
  GET DIAGNOSTICS v_released = ROW_COUNT;
  UPDATE public.bank_connections SET status = 'revoked', session_id = NULL, oauth_state = NULL,
    oauth_origin = NULL, authorization_id = NULL, error_message = NULL,
    superseded_by = p_connection_id, superseded_at = clock_timestamp()
    WHERE company_id = p_company_id AND id = ANY(v_ids);
  UPDATE public.bank_connections SET accounts_data = v_next,
    last_synced_at = coalesce(last_synced_at,v_last_synced),
    initial_sync_requested_from = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_requested_from ELSE initial_sync_requested_from END,
    initial_sync_returned_min_date = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_returned_min_date ELSE initial_sync_returned_min_date END,
    initial_sync_returned_max_date = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_returned_max_date ELSE initial_sync_returned_max_date END,
    initial_sync_lookback_days = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_lookback_days ELSE initial_sync_lookback_days END,
    initial_sync_completed_at = coalesce(initial_sync_completed_at,v_donor.initial_sync_completed_at)
    WHERE company_id = p_company_id AND id = p_connection_id;

  RETURN jsonb_build_object('superseded',v_superseded,'accounts',v_next,
    'moved_transactions',v_moved,'released_cash_accounts',v_released);
END;
$function$;
REVOKE ALL ON FUNCTION public.supersede_bank_connections(uuid,uuid,uuid,text,text,text[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.supersede_bank_connections(uuid,uuid,uuid,text,text,text[]) TO service_role;
NOTIFY pgrst, 'reload schema';
