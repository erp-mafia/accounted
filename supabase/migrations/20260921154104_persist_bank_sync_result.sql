-- A completed bank fetch owns observations, never the routing snapshot it read.
-- All sync entry points share this atomic, session-checked persistence boundary.
ALTER TABLE public.bank_connections
  ADD COLUMN sync_result_started_at timestamptz;

CREATE FUNCTION public.persist_bank_sync_result(
  p_company_id uuid,
  p_connection_id uuid,
  p_session_id text,
  p_started_at timestamptz,
  p_completed_at timestamptz,
  p_accounts jsonb,
  p_initial_sync jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_connection public.bank_connections;
  v_account jsonb;
  v_patch jsonb;
  v_next jsonb := '[]'::jsonb;
  v_balance_at timestamptz;
  v_accounts integer := 0;
BEGIN
  IF p_started_at IS NULL OR p_completed_at IS NULL
     OR p_started_at > p_completed_at
     OR p_completed_at > clock_timestamp() + interval '5 minutes'
     OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array'
     OR (p_initial_sync IS NOT NULL AND jsonb_typeof(p_initial_sync) <> 'object') THEN
    RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a
     WHERE jsonb_typeof(a) <> 'object' OR nullif(a->>'uid', '') IS NULL
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a GROUP BY a->>'uid' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID_ACCOUNTS' USING ERRCODE = '22023';
  END IF;

  -- RLS and invoker privileges also apply to the row lock and balance writes.
  SELECT * INTO v_connection FROM public.bank_connections
   WHERE id = p_connection_id AND company_id = p_company_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'not_found');
  END IF;
  IF v_connection.session_id IS DISTINCT FROM p_session_id THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'session_changed');
  END IF;
  IF v_connection.status IS NULL OR v_connection.status NOT IN ('active', 'error')
     OR v_connection.superseded_by IS NOT NULL THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'connection_inactive');
  END IF;
  IF v_connection.sync_result_started_at > p_started_at THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'newer_result_exists');
  END IF;
  -- A UID removed by reauthorization/sharing cannot be resurrected by a fetch.
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_accounts) a
     WHERE NOT EXISTS (
       SELECT 1 FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) c
        WHERE c->>'uid' = a->>'uid'
     )
  ) THEN
    RETURN jsonb_build_object('applied', false, 'reason', 'accounts_changed');
  END IF;

  FOR v_account IN SELECT value FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) LOOP
    SELECT value INTO v_patch FROM jsonb_array_elements(p_accounts)
     WHERE value->>'uid' = v_account->>'uid';
    IF FOUND THEN
      v_accounts := v_accounts + 1;
      -- An established external-id scope is immutable across observations.
      IF nullif(v_account->>'dedup_scope', '') IS NOT NULL
         AND nullif(v_patch->>'dedup_scope', '') IS NOT NULL
         AND v_account->>'dedup_scope' <> v_patch->>'dedup_scope' THEN
        RAISE EXCEPTION 'BANK_SYNC_DEDUP_SCOPE_CHANGED' USING ERRCODE = '40001';
      END IF;
      IF nullif(v_account->>'dedup_scope', '') IS NULL AND nullif(v_patch->>'dedup_scope', '') IS NOT NULL THEN
        v_account := v_account || jsonb_build_object('dedup_scope', v_patch->>'dedup_scope');
      END IF;
      IF v_patch ? 'accepted_history_days' THEN
        IF (v_patch->>'accepted_history_days')::integer < 0 THEN
          RAISE EXCEPTION 'BANK_SYNC_RESULT_INVALID_HISTORY' USING ERRCODE = '22023';
        END IF;
        v_account := v_account || jsonb_build_object('accepted_history_days', greatest(
          coalesce((v_account->>'accepted_history_days')::integer, 0),
          (v_patch->>'accepted_history_days')::integer
        ));
      END IF;
      v_balance_at := (v_patch->>'balance_updated_at')::timestamptz;
      IF v_balance_at IS NOT NULL AND v_balance_at <= p_completed_at + interval '5 minutes'
         AND (nullif(v_account->>'balance_updated_at', '') IS NULL
           OR v_balance_at >= (v_account->>'balance_updated_at')::timestamptz) THEN
        -- Whitelist observations: never accept ledger, enabled, IBAN or name.
        IF v_patch ? 'balance' THEN
          v_account := v_account || jsonb_build_object('balance', (v_patch->>'balance')::numeric);
        END IF;
        v_account := v_account || jsonb_build_object(
          'available_balance', (v_patch->>'available_balance')::numeric,
          'balance_updated_at', v_balance_at
        );
        UPDATE public.cash_accounts
           SET balance = CASE WHEN v_patch ? 'balance' THEN (v_patch->>'balance')::numeric ELSE balance END,
               available_balance = (v_patch->>'available_balance')::numeric,
               balance_updated_at = v_balance_at
         WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
           AND external_uid = v_account->>'uid'
           AND (balance_updated_at IS NULL OR balance_updated_at <= v_balance_at);
      END IF;
    END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;

  UPDATE public.bank_connections
     SET accounts_data = v_next,
         sync_result_started_at = p_started_at,
         last_synced_at = greatest(last_synced_at, p_completed_at),
         status = 'active', error_message = NULL,
         initial_sync_completed_at = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN p_completed_at ELSE initial_sync_completed_at END,
         initial_sync_requested_from = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'requested_from')::date ELSE initial_sync_requested_from END,
         initial_sync_returned_min_date = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'returned_min')::date ELSE initial_sync_returned_min_date END,
         initial_sync_returned_max_date = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'returned_max')::date ELSE initial_sync_returned_max_date END,
         initial_sync_lookback_days = CASE WHEN p_initial_sync IS NOT NULL AND initial_sync_completed_at IS NULL
           THEN (p_initial_sync->>'lookback_days')::integer ELSE initial_sync_lookback_days END
   WHERE id = p_connection_id AND company_id = p_company_id;
  RETURN jsonb_build_object('applied', true, 'account_count', v_accounts);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.persist_bank_sync_result(uuid, uuid, text, timestamptz, timestamptz, jsonb, jsonb)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_bank_sync_result(uuid, uuid, text, timestamptz, timestamptz, jsonb, jsonb)
  TO authenticated, service_role;

CREATE FUNCTION public.persist_bank_sync_failure(
  p_company_id uuid,
  p_connection_id uuid,
  p_session_id text,
  p_started_at timestamptz,
  p_status text,
  p_message text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
  IF p_started_at IS NULL OR p_started_at > clock_timestamp() + interval '5 minutes'
     OR p_status IS NULL OR p_status NOT IN ('expired', 'error') OR p_message IS NULL THEN
    RAISE EXCEPTION 'BANK_SYNC_FAILURE_INVALID' USING ERRCODE = '22023';
  END IF;
  UPDATE public.bank_connections
     SET status = p_status, error_message = p_message, sync_result_started_at = p_started_at
   WHERE id = p_connection_id AND company_id = p_company_id
     AND session_id IS NOT DISTINCT FROM p_session_id
     AND status IN ('active', 'error') AND superseded_by IS NULL
     AND (sync_result_started_at IS NULL OR sync_result_started_at <= p_started_at)
     AND (last_synced_at IS NULL OR last_synced_at <= p_started_at);
  RETURN FOUND;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.persist_bank_sync_failure(uuid, uuid, text, timestamptz, text, text)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.persist_bank_sync_failure(uuid, uuid, text, timestamptz, text, text)
  TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
