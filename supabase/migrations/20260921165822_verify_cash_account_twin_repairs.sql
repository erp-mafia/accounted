-- Receipts retain pseudonymous IDs and hashes, never bank identifiers or
-- transaction descriptions. Normalize timestamp rendering when hashing rows.
CREATE OR REPLACE FUNCTION public.cash_repair_state_hash(p_state jsonb)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT encode(sha256(convert_to(p_state::text, 'UTF8')), 'hex'); $$;

CREATE OR REPLACE FUNCTION public.cash_repair_transaction_state(p_company_id uuid, p_transaction_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' SET timezone = 'UTC'
AS $$
  SELECT jsonb_build_object('row', to_jsonb(t) - 'updated_at',
    'voucher_links', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.transaction_voucher_links a WHERE a.transaction_id = t.id),
    'invoice_payments', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.invoice_payments a WHERE a.transaction_id = t.id),
    'supplier_payments', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.supplier_invoice_payments a WHERE a.transaction_id = t.id))
  FROM public.transactions t WHERE t.company_id = p_company_id AND t.id = p_transaction_id;
$$;

CREATE OR REPLACE FUNCTION public.cash_repair_journal_state(p_company_id uuid, p_entry_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' SET timezone = 'UTC'
AS $$
  SELECT jsonb_build_object('entry', to_jsonb(e), 'lines', (
    SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]') FROM public.journal_entry_lines l WHERE l.journal_entry_id = e.id))
  FROM public.journal_entries e WHERE e.company_id = p_company_id AND e.id = p_entry_id;
$$;

CREATE OR REPLACE FUNCTION public.capture_cash_twin_expected_state(p_company_id uuid, p_groups jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' SET timezone = 'UTC'
AS $$
DECLARE
  v_group jsonb;
  v_keeper public.cash_accounts;
  v_live public.cash_accounts;
  v_cash public.cash_accounts;
  v_tx public.transactions;
  v_state jsonb;
  v_expected jsonb;
  v_ids uuid[];
  v_tx_ids uuid[] := '{}';
  v_entry_id uuid;
  v_target uuid;
  v_transfer_primary boolean;
  v_cash_proof jsonb := '[]';
  v_tx_proof jsonb := '[]';
  v_journal_proof jsonb := '[]';
BEGIN
  FOR v_group IN SELECT a FROM jsonb_array_elements(p_groups) a WHERE a->>'skipped' IS NULL LOOP
    SELECT * INTO STRICT v_keeper FROM public.cash_accounts
      WHERE company_id = p_company_id AND id = (v_group->'keeper'->>'id')::uuid;
    SELECT * INTO STRICT v_live FROM public.cash_accounts
      WHERE company_id = p_company_id AND id = (v_group->>'liveRowId')::uuid;
    SELECT array_agg((a->>'id')::uuid) INTO v_ids FROM jsonb_array_elements(v_group->'retired') a;
    v_ids := coalesce(v_ids, '{}') || v_keeper.id;
    SELECT coalesce(bool_or(is_primary), false) INTO v_transfer_primary
      FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_ids) AND id <> v_keeper.id;
    FOR v_cash IN SELECT * FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_ids) ORDER BY id LOOP
      v_expected := to_jsonb(v_cash) - ARRAY['balance','available_balance','balance_updated_at','updated_at'];
      IF v_cash.id = v_keeper.id THEN
        v_expected := v_expected || jsonb_build_object('bank_connection_id', v_live.bank_connection_id,
          'external_uid', v_live.external_uid, 'currency', upper(v_live.currency), 'iban', coalesce(v_live.iban, v_keeper.iban),
          'bban', coalesce(nullif(v_live.bban, ''), v_keeper.bban), 'name', coalesce(v_keeper.name, v_live.name),
          'enabled', v_live.enabled, 'source', 'enable_banking', 'is_primary', v_keeper.is_primary OR v_transfer_primary);
      ELSIF EXISTS (SELECT 1 FROM jsonb_array_elements(v_group->'retired') a
        WHERE a->>'id' = v_cash.id::text AND a->>'outcome' = 'deleted') THEN
        v_expected := NULL;
      ELSIF v_cash.bank_connection_id IS NULL THEN
        v_expected := v_expected || jsonb_build_object('is_primary', CASE WHEN v_transfer_primary THEN false ELSE v_cash.is_primary END);
      ELSE
        v_expected := v_expected || jsonb_build_object('bank_connection_id', NULL, 'external_uid', NULL,
          'is_primary', CASE WHEN v_transfer_primary THEN false ELSE v_cash.is_primary END);
      END IF;
      v_cash_proof := v_cash_proof || jsonb_build_array(jsonb_build_object('id', v_cash.id,
        'deleted', v_expected IS NULL, 'hash', public.cash_repair_state_hash(v_expected)));
    END LOOP;
    FOR v_tx IN SELECT * FROM public.transactions WHERE company_id = p_company_id AND cash_account_id = ANY(v_ids) ORDER BY id LOOP
      v_target := CASE WHEN v_tx.cash_account_id <> v_keeper.id AND public.cash_transaction_is_movable(p_company_id, v_tx.id)
        THEN v_keeper.id ELSE v_tx.cash_account_id END;
      v_state := public.cash_repair_transaction_state(p_company_id, v_tx.id);
      v_expected := jsonb_set(v_state, '{row,cash_account_id}', to_jsonb(v_target));
      v_tx_proof := v_tx_proof || jsonb_build_array(jsonb_build_object('id', v_tx.id, 'cashAccountId', v_target,
        'hash', public.cash_repair_state_hash(v_expected)));
      v_tx_ids := v_tx_ids || v_tx.id;
    END LOOP;
  END LOOP;
  FOR v_entry_id IN
    SELECT journal_entry_id FROM public.transactions WHERE company_id = p_company_id AND id = ANY(v_tx_ids) AND journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM public.transaction_voucher_links WHERE company_id = p_company_id AND transaction_id = ANY(v_tx_ids)
    UNION SELECT journal_entry_id FROM public.invoice_payments WHERE company_id = p_company_id AND transaction_id = ANY(v_tx_ids) AND journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM public.supplier_invoice_payments WHERE company_id = p_company_id AND transaction_id = ANY(v_tx_ids) AND journal_entry_id IS NOT NULL
  LOOP
    v_journal_proof := v_journal_proof || jsonb_build_array(jsonb_build_object('id', v_entry_id,
      'hash', public.cash_repair_state_hash(public.cash_repair_journal_state(p_company_id, v_entry_id))));
  END LOOP;
  RETURN jsonb_build_object('schemaVersion', 1, 'cashAccounts', v_cash_proof, 'transactions', v_tx_proof, 'journals', v_journal_proof);
END;
$$;

CREATE OR REPLACE FUNCTION public.check_cash_twin_expected_state(p_company_id uuid, p_proof jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' SET timezone = 'UTC'
AS $$
DECLARE
  v_item jsonb;
  v_current jsonb;
  v_issues jsonb := '[]';
BEGIN
  IF p_proof->>'schemaVersion' IS DISTINCT FROM '1'
    OR jsonb_typeof(p_proof->'cashAccounts') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_proof->'transactions') IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_proof->'journals') IS DISTINCT FROM 'array'
  THEN
    RETURN jsonb_build_object('status', 'insufficient-evidence', 'issues', '[]'::jsonb);
  END IF;
  FOR v_item IN SELECT a FROM jsonb_array_elements(p_proof->'cashAccounts') a LOOP
    SELECT to_jsonb(c) - ARRAY['balance','available_balance','balance_updated_at','updated_at'] INTO v_current
      FROM public.cash_accounts c WHERE c.company_id = p_company_id AND c.id = (v_item->>'id')::uuid;
    IF (v_item->>'deleted')::boolean THEN
      IF v_current IS NOT NULL THEN v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'retired-account-present', 'id', v_item->>'id')); END IF;
    ELSIF v_current IS NULL OR public.cash_repair_state_hash(v_current) IS DISTINCT FROM v_item->>'hash' THEN
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'cash-account-changed', 'id', v_item->>'id'));
    END IF;
  END LOOP;
  FOR v_item IN SELECT a FROM jsonb_array_elements(p_proof->'transactions') a LOOP
    v_current := public.cash_repair_transaction_state(p_company_id, (v_item->>'id')::uuid);
    IF v_current IS NULL OR public.cash_repair_state_hash(v_current) IS DISTINCT FROM v_item->>'hash' THEN
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'transaction-or-anchor-changed', 'id', v_item->>'id',
        'expectedCashAccountId', v_item->>'cashAccountId', 'currentCashAccountId', v_current->'row'->>'cash_account_id'));
    END IF;
  END LOOP;
  FOR v_item IN SELECT a FROM jsonb_array_elements(p_proof->'journals') a LOOP
    v_current := public.cash_repair_journal_state(p_company_id, (v_item->>'id')::uuid);
    IF v_current IS NULL OR public.cash_repair_state_hash(v_current) IS DISTINCT FROM v_item->>'hash' THEN
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'journal-changed', 'id', v_item->>'id'));
    END IF;
  END LOOP;
  RETURN jsonb_build_object('status', CASE WHEN jsonb_array_length(v_issues) = 0 THEN 'consistent' ELSE 'changed' END,
    'issues', v_issues, 'cashAccountsChecked', jsonb_array_length(p_proof->'cashAccounts'),
    'transactionsChecked', jsonb_array_length(p_proof->'transactions'), 'journalsChecked', jsonb_array_length(p_proof->'journals'));
END;
$$;

CREATE OR REPLACE FUNCTION public.inspect_cash_account_routing(p_company_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_connection public.bank_connections;
  v_entry jsonb;
  v_cash public.cash_accounts;
  v_count integer;
  v_reason text;
  v_issues jsonb := '[]';
BEGIN
  FOR v_connection IN SELECT * FROM public.bank_connections WHERE company_id = p_company_id
    AND status IN ('active','error') AND superseded_by IS NULL ORDER BY id
  LOOP
    FOR v_entry IN SELECT a FROM jsonb_array_elements(v_connection.accounts_data) a
      WHERE coalesce((a->>'enabled')::boolean, true) ORDER BY a->>'uid'
    LOOP
      v_reason := NULL;
      SELECT count(*) INTO v_count FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_entry->>'uid';
      SELECT * INTO v_cash FROM public.cash_accounts WHERE company_id = p_company_id
        AND bank_connection_id = v_connection.id AND external_uid = v_entry->>'uid';
      IF v_connection.session_id IS NULL THEN v_reason := 'missing-session';
      ELSIF v_entry->>'uid' IS NULL OR v_count <> 1 THEN v_reason := 'ambiguous-uid';
      ELSIF v_cash.id IS NULL THEN v_reason := 'missing-cash-account';
      ELSIF NOT v_cash.enabled THEN v_reason := 'disabled-cash-account';
      ELSIF upper(v_entry->>'currency') IS DISTINCT FROM v_cash.currency THEN v_reason := 'currency-mismatch';
      ELSIF v_entry->>'ledger_account' IS DISTINCT FROM v_cash.ledger_account THEN v_reason := 'ledger-mismatch';
      ELSIF nullif(v_entry->>'iban', '') IS NOT NULL AND
        nullif(upper(regexp_replace(v_entry->>'iban', '\s', '', 'g')), '') IS DISTINCT FROM
        nullif(upper(regexp_replace(v_cash.iban, '\s', '', 'g')), '') THEN v_reason := 'identity-mismatch';
      END IF;
      IF v_reason IS NOT NULL THEN
        v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', v_reason, 'connectionId', v_connection.id,
          'cashAccountId', v_cash.id, 'uidHash', public.cash_repair_state_hash(to_jsonb(v_entry->>'uid'))));
      END IF;
    END LOOP;
    FOR v_cash IN SELECT * FROM public.cash_accounts c WHERE c.company_id = p_company_id
      AND c.bank_connection_id = v_connection.id AND c.enabled AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_connection.accounts_data) a
        WHERE a->>'uid' = c.external_uid AND coalesce((a->>'enabled')::boolean, true)) ORDER BY c.id
    LOOP
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'cash-account-not-selected',
        'connectionId', v_connection.id, 'cashAccountId', v_cash.id,
        'uidHash', public.cash_repair_state_hash(to_jsonb(v_cash.external_uid))));
    END LOOP;
  END LOOP;
  RETURN v_issues;
END;
$$;

CREATE OR REPLACE FUNCTION public.verify_cash_account_twin_repair(p_company_id uuid, p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_receipt public.processing_history;
  v_check jsonb;
  v_routing jsonb;
BEGIN
  SELECT * INTO v_receipt FROM public.processing_history WHERE company_id = p_company_id
    AND event_id = p_operation_id AND event_type = 'CashAccountTwinsMerged';
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_RECEIPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_check := public.check_cash_twin_expected_state(p_company_id, v_receipt.payload->'verification');
  v_routing := public.inspect_cash_account_routing(p_company_id);
  RETURN v_check || jsonb_build_object('companyId', p_company_id, 'operationId', p_operation_id,
    'receiptPhase', v_receipt.payload->>'phase', 'routingIssues', v_routing,
    'verifiedAt', statement_timestamp(), 'status', CASE
      WHEN v_receipt.payload->>'phase' IS DISTINCT FROM 'completed' OR v_check->>'status' = 'insufficient-evidence' THEN 'insufficient-evidence'
      WHEN v_check->>'status' = 'changed' OR jsonb_array_length(v_routing) > 0 THEN 'changed' ELSE 'consistent' END);
END;
$$;

CREATE OR REPLACE FUNCTION public.heal_cash_account_twins(
  p_company_id uuid, p_expected_fingerprint text, p_operation_id uuid, p_actor jsonb
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_prior public.processing_history;
  v_plan jsonb;
  v_group jsonb;
  v_live public.cash_accounts;
  v_keeper public.cash_accounts;
  v_session text;
  v_retire uuid[];
  v_result jsonb;
  v_expected_state jsonb;
  v_verification jsonb;
  v_receipt_groups jsonb := '[]';
BEGIN
  IF p_operation_id IS NULL OR p_expected_fingerprint IS NULL OR p_expected_fingerprint !~ '^[0-9a-f]{64}$'
    OR jsonb_typeof(p_actor) IS DISTINCT FROM 'object'
    OR p_actor->>'type' IS NULL OR p_actor->>'type' NOT IN ('user','system','cron','api_key','llm')
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_HEAL_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_prior FROM public.processing_history WHERE event_id = p_operation_id;
  IF FOUND THEN
    IF v_prior.company_id IS DISTINCT FROM p_company_id OR v_prior.event_type <> 'CashAccountTwinsMerged'
      OR v_prior.payload->>'plan_fingerprint' IS DISTINCT FROM p_expected_fingerprint
      OR v_prior.payload->>'phase' IS DISTINCT FROM 'completed' OR v_prior.actor IS DISTINCT FROM p_actor
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_ID_CONFLICT' USING ERRCODE = '23505';
    END IF;
    RETURN v_prior.payload->'result';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.transactions WHERE company_id = p_company_id AND cash_account_id IS NOT NULL ORDER BY id FOR UPDATE;
  v_plan := public.plan_cash_account_twins(p_company_id);
  IF v_plan->>'fingerprint' IS DISTINCT FROM p_expected_fingerprint THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PLAN_CHANGED: nothing written, review the new dry run' USING ERRCODE = '40001';
  END IF;
  v_expected_state := public.capture_cash_twin_expected_state(p_company_id, v_plan->'groups');
  FOR v_group IN SELECT a FROM jsonb_array_elements(v_plan->'groups') a WHERE a->>'skipped' IS NULL LOOP
    SELECT * INTO v_live FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_group->>'liveRowId')::uuid;
    SELECT * INTO v_keeper FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_group->'keeper'->>'id')::uuid;
    SELECT session_id INTO v_session FROM public.bank_connections WHERE company_id = p_company_id AND id = v_live.bank_connection_id;
    SELECT coalesce(array_agg((a->>'id')::uuid), '{}') INTO v_retire FROM jsonb_array_elements(v_group->'retired') a;
    PERFORM public.promote_psd2_cash_account(p_company_id, jsonb_build_object(
      'bank_connection_id', v_live.bank_connection_id, 'external_uid', v_live.external_uid,
      'currency', v_live.currency, 'ledger_account', v_keeper.ledger_account, 'iban', v_live.iban,
      'bban', v_live.bban, 'name', coalesce(v_keeper.name, v_live.name), 'enabled', v_live.enabled,
      'reuse_cash_account_id', v_keeper.id, 'expected_session_id', v_session,
      'balance', v_live.balance, 'available_balance', v_live.available_balance, 'balance_updated_at', v_live.balance_updated_at
    ), v_retire);
  END LOOP;
  v_verification := public.check_cash_twin_expected_state(p_company_id, v_expected_state);
  IF v_verification->>'status' IS DISTINCT FROM 'consistent' THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_HEAL_VERIFICATION_FAILED' USING ERRCODE = '23514', DETAIL = v_verification::text;
  END IF;
  -- A receipt contains IDs and ledger identifiers, never an IBAN. It remains
  -- discoverable by operation ID after the final twin is gone.
  SELECT coalesce(jsonb_agg(a - 'physicalKey'), '[]') INTO v_receipt_groups FROM jsonb_array_elements(v_plan->'groups') a;
  v_result := (v_plan - 'groups') || jsonb_build_object('dryRun', false, 'groups', v_receipt_groups, 'operationId', p_operation_id, 'verification', v_verification);
  INSERT INTO public.processing_history(event_id, company_id, correlation_id, aggregate_type, aggregate_id,
    event_type, payload, payload_schema_version, actor, occurred_at)
  VALUES (p_operation_id, p_company_id, p_operation_id, 'System', p_company_id, 'CashAccountTwinsMerged',
    jsonb_build_object('phase', 'completed', 'plan_fingerprint', p_expected_fingerprint, 'result', v_result, 'verification', v_expected_state), 3, p_actor, clock_timestamp());
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.cash_repair_state_hash(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_repair_state_hash(jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.cash_repair_transaction_state(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_repair_transaction_state(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.cash_repair_journal_state(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.cash_repair_journal_state(uuid, uuid) TO service_role;
REVOKE ALL ON FUNCTION public.capture_cash_twin_expected_state(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.capture_cash_twin_expected_state(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.check_cash_twin_expected_state(uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.check_cash_twin_expected_state(uuid, jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.inspect_cash_account_routing(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_cash_account_routing(uuid) TO service_role;
REVOKE ALL ON FUNCTION public.verify_cash_account_twin_repair(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.verify_cash_account_twin_repair(uuid, uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
