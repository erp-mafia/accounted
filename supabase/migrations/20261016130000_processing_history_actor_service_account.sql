-- processing_history's actor vocabulary gains 'service_account', end to end
-- (follow-up of 20261016120000/120100, decision
-- 2026-10-16-processing-history-actor-vocabulary-unchanged).
-- pg-test: tests/pg/cash-account-twin-heal.pg.test.ts
--
-- processing_history.actor is a JSONB object with no CHECK on its type: the
-- vocabulary lives in the application (ProcessingHistoryActorType,
-- src/types/index.ts) and in the one SQL function that refuses a type outside
-- it, heal_cash_account_twins. The application now records a service
-- account's key as { type: 'service_account', id: <key id>, label: <account
-- name> } where it recorded api_key; this keeps the function's list in step
-- with the TypeScript union, so a receipt written for a service account is
-- not refused as CASH_ACCOUNT_HEAL_INVALID_INPUT.
--
-- Body copied byte for byte from its latest definition,
-- 20261012100100_restate_patched_functions (pg_get_functiondef output), with
-- one change: 'service_account' appended to the actor type list. Signature,
-- owner, grants, SECURITY INVOKER and search_path are unchanged (CREATE OR
-- REPLACE keeps them). No table is altered and no row is rewritten.
--
-- No CHECK constraint is added to processing_history: nothing in the
-- repository shows which actor types older rows carry, and an append whose
-- type falls outside a new CHECK would be lost silently by the best-effort
-- callers (decision 2026-10-16-processing-history-no-actor-check).

CREATE OR REPLACE FUNCTION public.heal_cash_account_twins(p_company_id uuid, p_expected_fingerprint text, p_operation_id uuid, p_actor jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
    OR p_actor->>'type' IS NULL OR p_actor->>'type' NOT IN ('user','system','cron','api_key','llm','service_account')
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
    RAISE EXCEPTION 'CASH_ACCOUNT_PLAN_CHANGED: nothing written, review the new dry run' USING ERRCODE = 'PT409';
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
$function$
;
