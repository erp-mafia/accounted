-- Include repaired accounts whose connections no longer appear in the live-route scan.
CREATE OR REPLACE FUNCTION public.verify_cash_account_twin_repair(p_company_id uuid, p_operation_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_receipt public.processing_history;
  v_check jsonb;
  v_routing jsonb;
  v_affected record;
  v_kind text;
BEGIN
  SELECT * INTO v_receipt FROM public.processing_history WHERE company_id = p_company_id
    AND event_id = p_operation_id AND event_type = 'CashAccountTwinsMerged';
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_RECEIPT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  v_check := public.check_cash_twin_expected_state(p_company_id, v_receipt.payload->'verification');
  v_routing := public.inspect_cash_account_routing(p_company_id);
  -- The company scan checks active routes. A receipt also expects its kept
  -- accounts to have usable connections, including accounts disabled at repair.
  IF v_check->>'status' <> 'insufficient-evidence' THEN
    FOR v_affected IN
      SELECT c.id, c.bank_connection_id, c.external_uid, b.status, b.superseded_by, b.session_id
      FROM jsonb_array_elements(v_receipt.payload->'verification'->'cashAccounts') expected
      JOIN public.cash_accounts c ON c.id = (expected->>'id')::uuid AND c.company_id = p_company_id
      JOIN public.bank_connections b ON b.id = c.bank_connection_id AND b.company_id = p_company_id
      WHERE b.status NOT IN ('active','error') OR b.superseded_by IS NOT NULL OR b.session_id IS NULL
    LOOP
      v_kind := CASE WHEN v_affected.status NOT IN ('active','error') OR v_affected.superseded_by IS NOT NULL
        THEN 'inactive-connection' ELSE 'missing-session' END;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_routing) a
        WHERE a->>'cashAccountId' = v_affected.id::text AND a->>'kind' = v_kind) THEN
        v_routing := v_routing || jsonb_build_array(jsonb_build_object('kind', v_kind,
          'connectionId', v_affected.bank_connection_id, 'cashAccountId', v_affected.id,
          'uidHash', public.cash_repair_state_hash(to_jsonb(v_affected.external_uid))));
      END IF;
    END LOOP;
  END IF;
  RETURN v_check || jsonb_build_object('companyId', p_company_id, 'operationId', p_operation_id,
    'receiptPhase', v_receipt.payload->>'phase', 'routingIssues', v_routing,
    'verifiedAt', statement_timestamp(), 'status', CASE
      WHEN v_receipt.payload->>'phase' IS DISTINCT FROM 'completed' OR v_check->>'status' = 'insufficient-evidence' THEN 'insufficient-evidence'
      WHEN v_check->>'status' = 'changed' OR jsonb_array_length(v_routing) > 0 THEN 'changed' ELSE 'consistent' END);
END;
$$;

NOTIFY pgrst, 'reload schema';
