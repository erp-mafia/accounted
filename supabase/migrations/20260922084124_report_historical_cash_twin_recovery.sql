-- Old started events contain planned row IDs/counts, not the later atomic
-- executor's before-state hashes and movement IDs. Report current consistency
-- with that recorded intent without asserting a historical commit or time.
CREATE FUNCTION public.inspect_historical_cash_twin_repair(p_company_id uuid, p_started_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = '' SET timezone = 'UTC'
AS $function$
DECLARE
  v_started public.processing_history; v_payload jsonb; v_base jsonb; v_completions jsonb;
  v_keeper public.cash_accounts; v_live public.cash_accounts; v_row public.cash_accounts;
  v_connection public.bank_connections; v_item jsonb; v_account jsonb;
  v_retired jsonb := '[]'; v_issues jsonb := '[]'; v_route jsonb := '{}';
  v_contradictory boolean := false; v_partial boolean := false; v_insufficient boolean := false;
  v_iban text; v_uid text; v_count bigint; v_movable bigint; v_total bigint; v_dependencies text[];
  v_uuid_regex constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  SELECT * INTO v_started FROM public.processing_history WHERE company_id = p_company_id
    AND event_id = p_started_event_id AND event_type = 'CashAccountTwinsMerged' AND payload->>'phase' = 'started';
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_STARTED_EVENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',event_id,'recordedAt',occurred_at) ORDER BY occurred_at,event_id),'[]')
    INTO v_completions FROM public.processing_history WHERE company_id = p_company_id
      AND event_type = 'CashAccountTwinsMerged' AND causation_id = p_started_event_id AND payload->>'phase' = 'completed';
  v_base := jsonb_build_object('companyId',p_company_id,'startedEventId',p_started_event_id,
    'startedAt',v_started.occurred_at,'observedAt',statement_timestamp(),'completionRecords',v_completions,
    'classification','insufficient-evidence','issues','[]'::jsonb,'retired','[]'::jsonb,'route','{}'::jsonb,
    'limitations',jsonb_build_array('current-state-only','original-provider-identity-not-recorded',
      'original-transaction-ids-and-bindings-not-recorded','original-primary-state-not-recorded',
      'original-journal-and-dependency-state-not-recorded','no-historical-completion-time-inferred'));
  v_payload := v_started.payload;
  IF jsonb_typeof(v_payload->'keeper') IS DISTINCT FROM 'object'
    OR coalesce(v_payload->'keeper'->>'id','') !~* v_uuid_regex
    OR coalesce(v_payload->'keeper'->>'ledger_account','') !~ '^[0-9]{4}$'
    OR coalesce(v_payload->>'live_row_id','') !~* v_uuid_regex
    OR coalesce(v_payload->>'bank_connection_id','') !~* v_uuid_regex
    OR v_payload->>'sync_ledger_after' IS DISTINCT FROM v_payload->'keeper'->>'ledger_account'
    OR (v_payload->>'sync_ledger_before' IS NOT NULL AND v_payload->>'sync_ledger_before' !~ '^[0-9]{4}$')
    OR jsonb_typeof(v_payload->'retired') IS DISTINCT FROM 'array' THEN
    RETURN v_base || jsonb_build_object('issues',jsonb_build_array(jsonb_build_object('kind','malformed-started-payload')));
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'retired') r WHERE jsonb_typeof(r) <> 'object'
    OR coalesce(r->>'id','') !~* v_uuid_regex OR coalesce(r->>'ledger_account','') !~ '^[0-9]{4}$'
    OR r->>'id' = v_payload->'keeper'->>'id'
    OR jsonb_typeof(r->'movable') IS DISTINCT FROM 'number' OR coalesce(r->>'movable','') !~ '^[0-9]{1,10}$'
    OR jsonb_typeof(r->'staying') IS DISTINCT FROM 'number' OR coalesce(r->>'staying','') !~ '^[0-9]{1,10}$'
    OR coalesce(r->>'outcome','') NOT IN ('rekeyed-into-keeper','deleted','demoted-to-manual','kept-manual'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'retired') r GROUP BY r->>'id' HAVING count(*) > 1)
    OR (v_payload->>'live_row_id' <> v_payload->'keeper'->>'id' AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_payload->'retired') r WHERE r->>'id' = v_payload->>'live_row_id')) THEN
    RETURN v_base || jsonb_build_object('issues',jsonb_build_array(jsonb_build_object('kind','malformed-retirement-intent')));
  END IF;
  SELECT * INTO v_keeper FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_payload->'keeper'->>'id')::uuid;
  IF NOT FOUND THEN
    RETURN v_base || jsonb_build_object('classification','contradictory',
      'issues',jsonb_build_array(jsonb_build_object('kind','keeper-missing','id',v_payload->'keeper'->>'id')));
  END IF;
  v_base := v_base || jsonb_build_object('keeper',jsonb_build_object('id',v_keeper.id,
    'expectedLedger',v_payload->'keeper'->>'ledger_account','currentLedger',CASE WHEN v_keeper.ledger_account ~ '^[0-9]{4}$' THEN v_keeper.ledger_account END,'isPrimary',v_keeper.is_primary));
  IF v_keeper.ledger_account IS DISTINCT FROM v_payload->'keeper'->>'ledger_account' THEN
    v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-ledger-changed','id',v_keeper.id));
  END IF;
  v_iban := nullif(upper(regexp_replace(v_keeper.iban,'\s','','g')),'');
  IF v_iban IS NULL THEN
    v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-physical-identity-unavailable','id',v_keeper.id));
  END IF;
  SELECT * INTO v_live FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_payload->>'live_row_id')::uuid;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = (v_payload->>'bank_connection_id')::uuid;
  v_route := jsonb_build_object('connectionId',v_payload->>'bank_connection_id','status',v_connection.status,
    'expectedLedger',v_payload->>'sync_ledger_after');
  IF v_connection.id IS NULL OR v_connection.status = 'revoked' OR v_connection.superseded_by IS NOT NULL OR v_connection.session_id IS NULL THEN
    v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','original-connection-no-longer-available','id',v_payload->>'bank_connection_id'));
  ELSIF jsonb_typeof(v_connection.accounts_data) IS DISTINCT FROM 'array' THEN
    v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','current-route-metadata-unavailable','id',v_connection.id));
  ELSE
    v_uid := CASE WHEN v_keeper.bank_connection_id = v_connection.id THEN v_keeper.external_uid
      WHEN v_live.bank_connection_id = v_connection.id THEN v_live.external_uid END;
    IF v_uid IS NOT NULL THEN
      SELECT count(*) INTO v_count FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_uid;
      SELECT a INTO v_account FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_uid;
    ELSE
      SELECT count(*) INTO v_count FROM jsonb_array_elements(v_connection.accounts_data) a
        WHERE upper(a->>'currency') = v_keeper.currency AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban;
      SELECT a INTO v_account FROM jsonb_array_elements(v_connection.accounts_data) a
        WHERE upper(a->>'currency') = v_keeper.currency AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban;
    END IF;
    IF v_count <> 1 OR nullif(v_account->>'uid','') IS NULL THEN
      v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','current-route-identity-ambiguous','id',v_connection.id));
    ELSE
      v_route := v_route || jsonb_build_object('currentLedger',CASE WHEN v_account->>'ledger_account' ~ '^[0-9]{4}$' THEN v_account->>'ledger_account' END,
        'keeperOwnsUid',coalesce(v_keeper.bank_connection_id = v_connection.id AND v_keeper.external_uid = v_account->>'uid',false));
      IF nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'') IS NULL THEN
        v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-physical-identity-unavailable','id',v_connection.id));
      ELSIF upper(v_account->>'currency') IS DISTINCT FROM v_keeper.currency
        OR (v_iban IS NOT NULL AND nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'') IS DISTINCT FROM v_iban) THEN
        v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-physical-identity-conflict','id',v_connection.id));
      END IF;
      IF (v_account ? 'enabled' AND jsonb_typeof(v_account->'enabled') IS DISTINCT FROM 'boolean') THEN
        v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-selection-unavailable','id',v_connection.id));
      ELSIF coalesce((v_account->>'enabled')::boolean,true) IS DISTINCT FROM v_keeper.enabled THEN
        v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-selection-conflict','id',v_keeper.id));
      END IF;
      IF v_account->>'ledger_account' IS DISTINCT FROM v_payload->>'sync_ledger_after' THEN
        IF v_account->>'ledger_account' IS NOT DISTINCT FROM v_payload->>'sync_ledger_before' THEN
          v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-still-at-recorded-before-state','id',v_connection.id));
        ELSE
          v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-outside-recorded-intent','id',v_connection.id));
        END IF;
      END IF;
      IF v_keeper.bank_connection_id IS DISTINCT FROM v_connection.id OR v_keeper.external_uid IS DISTINCT FROM v_account->>'uid' THEN
        IF v_keeper.bank_connection_id IS NOT NULL AND v_keeper.bank_connection_id <> v_connection.id THEN
          v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-now-on-another-connection','id',v_keeper.id));
        ELSE
          v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-provider-handover-incomplete','id',v_keeper.id));
        END IF;
      END IF;
    END IF;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_payload->'retired') ORDER BY value->>'id' LOOP
    SELECT * INTO v_row FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_item->>'id')::uuid;
    SELECT count(*),count(*) FILTER (WHERE public.cash_transaction_is_movable(p_company_id,t.id)) INTO v_total,v_movable
      FROM public.transactions t WHERE t.company_id = p_company_id AND t.cash_account_id = (v_item->>'id')::uuid;
    v_dependencies := coalesce(public.cash_account_retirement_dependencies(p_company_id,(v_item->>'id')::uuid),'{}');
    v_retired := v_retired || jsonb_build_array(jsonb_build_object('id',v_item->>'id','expectedLedger',v_item->>'ledger_account',
      'plannedOutcome',v_item->>'outcome','plannedMovable',v_item->'movable','plannedStaying',v_item->'staying',
      'exists',v_row.id IS NOT NULL,'currentLedger',CASE WHEN v_row.ledger_account ~ '^[0-9]{4}$' THEN v_row.ledger_account END,'currentMovable',v_movable,'currentStaying',v_total-v_movable,
      'hasProviderClaim',v_row.bank_connection_id IS NOT NULL OR v_row.external_uid IS NOT NULL,
      'isPrimary',v_row.is_primary,'dependencies',to_jsonb(v_dependencies)));
    IF v_row.id IS NULL THEN
      IF v_item->>'outcome' IN ('kept-manual','demoted-to-manual') OR (v_item->>'staying')::bigint > 0 THEN
        v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retained-row-missing','id',v_item->>'id'));
      END IF;
      CONTINUE;
    END IF;
    IF v_row.ledger_account IS DISTINCT FROM v_item->>'ledger_account' OR v_row.currency IS DISTINCT FROM v_keeper.currency
      OR (v_iban IS NOT NULL AND nullif(upper(regexp_replace(v_row.iban,'\s','','g')),'') IS DISTINCT FROM v_iban) THEN
      v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retired-row-identity-conflict','id',v_row.id));
    END IF;
    IF v_item->>'outcome' = 'deleted' OR v_movable > 0 OR v_row.bank_connection_id IS NOT NULL OR v_row.external_uid IS NOT NULL OR v_row.is_primary THEN
      v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retirement-incomplete','id',v_row.id));
    END IF;
    IF v_item->>'outcome' <> 'kept-manual' AND cardinality(v_dependencies) > 0 THEN
      v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retirement-needs-dependency-review','id',v_row.id));
    END IF;
  END LOOP;
  RETURN v_base || jsonb_build_object('route',v_route,'retired',v_retired,'issues',v_issues,'classification',CASE
    WHEN v_contradictory THEN 'contradictory' WHEN v_insufficient THEN 'insufficient-evidence'
    WHEN v_partial THEN 'partial' ELSE 'consistent-with-completion' END);
END;
$function$;

-- Explicit inspection can include an already completed legacy event. The
-- default inventory returns only started records without a completion marker,
-- irrespective of whether the company still has any discoverable twins.
CREATE FUNCTION public.report_historical_cash_twin_repairs(p_company_id uuid DEFAULT NULL, p_started_event_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_result jsonb;
BEGIN
  IF p_started_event_id IS NOT NULL THEN
    IF p_company_id IS NULL THEN RAISE EXCEPTION 'CASH_ACCOUNT_RECOVERY_COMPANY_REQUIRED' USING ERRCODE = '22023'; END IF;
    RETURN jsonb_build_array(public.inspect_historical_cash_twin_repair(p_company_id,p_started_event_id));
  END IF;
  SELECT coalesce(jsonb_agg(public.inspect_historical_cash_twin_repair(s.company_id,s.event_id) ORDER BY s.occurred_at,s.event_id),'[]')
    INTO v_result FROM public.processing_history s WHERE s.event_type = 'CashAccountTwinsMerged' AND s.payload->>'phase' = 'started'
      AND (p_company_id IS NULL OR s.company_id = p_company_id) AND NOT EXISTS (
        SELECT 1 FROM public.processing_history c WHERE c.company_id = s.company_id AND c.event_type = s.event_type
          AND c.causation_id = s.event_id AND c.payload->>'phase' = 'completed');
  RETURN v_result;
END;
$function$;
REVOKE ALL ON FUNCTION public.inspect_historical_cash_twin_repair(uuid,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.report_historical_cash_twin_repairs(uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.inspect_historical_cash_twin_repair(uuid,uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.report_historical_cash_twin_repairs(uuid,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
