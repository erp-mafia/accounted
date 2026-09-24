-- Configuration snapshots exclude observations owned by bank sync. Selection
-- reads one snapshot and commits against the same configuration under the
-- company, ordered connection and ordered cash-account locks.
CREATE FUNCTION public.bank_connection_configuration_state(p_row jsonb)
RETURNS jsonb LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $function$
  SELECT jsonb_build_object('id', p_row->'id', 'company', p_row->'company_id',
    'session', p_row->'session_id', 'status', p_row->'status',
    'superseded_by', p_row->'superseded_by', 'oauth_state', p_row->'oauth_state',
    'consent_expires', p_row->'consent_expires', 'provider', p_row->'provider',
    'bank_name', p_row->'bank_name', 'psu_type', p_row->'psu_type',
    'accounts', (SELECT coalesce(jsonb_agg(a - ARRAY['balance','available_balance',
      'balance_updated_at','accepted_history_days','dedup_scope'] ORDER BY a->>'uid'), '[]')
      FROM jsonb_array_elements(coalesce(nullif(p_row->'accounts_data', 'null'::jsonb), '[]')) a));
$function$;

CREATE FUNCTION public.bank_configuration_token(p_company_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' SET timezone = 'UTC'
AS $function$
  SELECT encode(extensions.digest(jsonb_build_object('version', 1, 'company', p_company_id,
    'connections', (SELECT coalesce(jsonb_agg(public.bank_connection_configuration_state(to_jsonb(b)) ORDER BY b.id), '[]')
      FROM public.bank_connections b WHERE b.company_id = p_company_id),
    'cash', (SELECT coalesce(jsonb_agg(to_jsonb(c) - ARRAY['balance','available_balance','balance_updated_at','updated_at'] ORDER BY c.id), '[]')
      FROM public.cash_accounts c WHERE c.company_id = p_company_id),
    'posted_ledgers', (SELECT coalesce(jsonb_agg(account_number ORDER BY account_number), '[]') FROM (
      SELECT DISTINCT l.account_number FROM public.journal_entry_lines l JOIN public.journal_entries j ON j.id = l.journal_entry_id
      WHERE j.company_id = p_company_id AND j.status IN ('posted','reversed') AND l.account_number ~ '^19[0-9]{2}$'
    ) ledgers)
  )::text, 'sha256'), 'hex');
$function$;

CREATE FUNCTION public.read_bank_configuration(p_company_id uuid, p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_connection public.bank_connections;
BEGIN
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('token', public.bank_configuration_token(p_company_id), 'connection',
    jsonb_build_object('id', v_connection.id, 'status', v_connection.status, 'accounts_data', v_connection.accounts_data,
      'session_id', v_connection.session_id, 'bank_name', v_connection.bank_name));
END;
$function$;

-- Direct row writers also participate, including account creation. A row
-- trigger can already own its business row; NOWAIT avoids inverting the
-- company-first protocol. Balance/cursor observations need no company lock.
CREATE FUNCTION public.guard_bank_configuration_writer()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_company uuid;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF TG_TABLE_NAME = 'cash_accounts' THEN
      IF to_jsonb(NEW) - ARRAY['balance','available_balance','balance_updated_at','updated_at']
        = to_jsonb(OLD) - ARRAY['balance','available_balance','balance_updated_at','updated_at'] THEN RETURN NEW; END IF;
    ELSIF public.bank_connection_configuration_state(to_jsonb(NEW))
      = public.bank_connection_configuration_state(to_jsonb(OLD)) THEN RETURN NEW;
    END IF;
  END IF;
  FOR v_company IN SELECT DISTINCT id FROM unnest(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.company_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.company_id END
  ]) id WHERE id IS NOT NULL ORDER BY id LOOP
    -- Parent deletion already holds this company's row lock. Its FK cascade
    -- runs after the parent row is gone and cannot create a new bank claim.
    IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM public.companies WHERE id = v_company) THEN CONTINUE; END IF;
    PERFORM public.lock_cash_account_company(v_company, false);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER bank_configuration_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.cash_accounts
  FOR EACH ROW EXECUTE FUNCTION public.guard_bank_configuration_writer();
CREATE TRIGGER bank_configuration_writer_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bank_connections
  FOR EACH ROW EXECUTE FUNCTION public.guard_bank_configuration_writer();

CREATE FUNCTION public.save_bank_account_selection(
  p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_expected_token text,
  p_selections jsonb, p_chart_accounts jsonb DEFAULT '[]'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_connection public.bank_connections;
  v_account jsonb; v_selection jsonb; v_next jsonb := '[]'; v_entry jsonb;
  v_chart public.chart_of_accounts; v_result jsonb; v_mirrors jsonb := '[]';
  v_enabled integer;
BEGIN
  IF jsonb_typeof(p_selections) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_chart_accounts) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'BANK_SELECTION_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM public.lock_cash_account_company(p_company_id);
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid())
    OR NOT EXISTS (SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_user_id
      AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_SELECTION_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF p_expected_token IS DISTINCT FROM public.bank_configuration_token(p_company_id)
    OR v_connection.status NOT IN ('active','pending_selection')
    OR v_connection.session_id IS NULL OR v_connection.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_CONFIGURATION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF jsonb_array_length(p_selections) <> jsonb_array_length(v_connection.accounts_data)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(p_selections) s
      WHERE jsonb_typeof(s) <> 'object' OR nullif(s->>'uid','') IS NULL
        OR jsonb_typeof(s->'enabled') IS DISTINCT FROM 'boolean'
        OR (SELECT count(*) FROM jsonb_array_elements(p_selections) x WHERE x->>'uid' = s->>'uid') <> 1
        OR (SELECT count(*) FROM jsonb_array_elements(v_connection.accounts_data) x WHERE x->>'uid' = s->>'uid') <> 1
        OR (s ? 'ledger_account' AND s->'ledger_account' <> 'null'::jsonb AND s->>'ledger_account' !~ '^19[0-9]{2}$')
        OR ((s->>'enabled')::boolean AND nullif(s->>'ledger_account','') IS NULL)) THEN
    RAISE EXCEPTION 'BANK_SELECTION_INVALID' USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_enabled FROM jsonb_array_elements(p_selections) s WHERE (s->>'enabled')::boolean;
  IF v_enabled < 1 OR v_enabled > 50 OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(p_selections) s WHERE nullif(s->>'ledger_account','') IS NOT NULL
    GROUP BY s->>'ledger_account' HAVING count(*) > 1
  ) THEN RAISE EXCEPTION 'BANK_SELECTION_LEDGER_CONFLICT' USING ERRCODE = '23514'; END IF;

  -- Only selection fields come from the caller. Current provider identity,
  -- balance, cursor, dedup scope and accepted history stay authoritative.
  FOR v_account IN SELECT value FROM jsonb_array_elements(v_connection.accounts_data) LOOP
    SELECT value INTO v_selection FROM jsonb_array_elements(p_selections) s WHERE s->>'uid' = v_account->>'uid';
    v_entry := (v_account - 'ledger_account') || jsonb_build_object('enabled', (v_selection->>'enabled')::boolean);
    IF nullif(v_selection->>'ledger_account','') IS NOT NULL THEN
      v_entry := v_entry || jsonb_build_object('ledger_account', v_selection->>'ledger_account');
    END IF;
    IF (v_selection->>'enabled')::boolean THEN
      v_entry := v_entry - ARRAY['claimed_by_company_id','claimed_by_company_name','deselected_elsewhere','mirror_card_account'];
    END IF;
    v_next := v_next || jsonb_build_array(v_entry);
  END LOOP;

  -- Newly allocated chart rows are part of this transaction too. Existing
  -- chart names and metadata are preserved; unused injected rows are refused.
  FOR v_chart IN SELECT * FROM jsonb_populate_recordset(NULL::public.chart_of_accounts, p_chart_accounts) LOOP
    IF v_chart.account_number IS NULL OR v_chart.account_number !~ '^19[0-9]{2}$'
      OR v_chart.account_class IS DISTINCT FROM 1 OR v_chart.account_type IS DISTINCT FROM 'asset'
      OR v_chart.normal_balance IS DISTINCT FROM 'debit'
      OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(p_selections) s WHERE s->>'ledger_account' = v_chart.account_number) THEN
      RAISE EXCEPTION 'BANK_SELECTION_CHART_INVALID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.chart_of_accounts(company_id,user_id,account_number,account_name,account_class,account_group,
      account_type,normal_balance,sru_code,k2_excluded,plan_type,is_active,is_system_account,description,sort_order)
    VALUES(p_company_id,p_user_id,v_chart.account_number,v_chart.account_name,1,v_chart.account_group,
      'asset','debit',v_chart.sru_code,coalesce(v_chart.k2_excluded,false),'full_bas',true,false,v_chart.description,v_chart.sort_order)
    ON CONFLICT(company_id,account_number) DO NOTHING;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(p_selections) s WHERE nullif(s->>'ledger_account','') IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.chart_of_accounts c WHERE c.company_id = p_company_id AND c.account_number = s->>'ledger_account')) THEN
    RAISE EXCEPTION 'BANK_SELECTION_CHART_ACCOUNT_MISSING' USING ERRCODE = '23514';
  END IF;

  -- Derive releases under lock. A caller cannot ask to release an unrelated
  -- row or a live claim from another connection. Physical identity is checked
  -- again by the shared promotion function before any final binding changes.
  UPDATE public.cash_accounts c SET bank_connection_id = NULL, external_uid = NULL
  WHERE c.company_id = p_company_id AND c.bank_connection_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM public.bank_connections b WHERE b.id = c.bank_connection_id AND b.status = 'revoked')
    AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_selections) s
      WHERE (s->>'enabled')::boolean AND s->>'ledger_account' = c.ledger_account
        AND c.id IS DISTINCT FROM nullif(s->>'reuse_cash_account_id','')::uuid
        AND ((c.bank_connection_id = p_connection_id AND c.external_uid IS DISTINCT FROM s->>'uid')
          OR (c.bank_connection_id <> p_connection_id AND c.enabled = false)));
  UPDATE public.bank_connections SET accounts_data = v_next,
    status = CASE WHEN status = 'pending_selection' THEN 'active' ELSE status END
  WHERE company_id = p_company_id AND id = p_connection_id;

  FOR v_account IN SELECT value FROM jsonb_array_elements(v_next) LOOP
    IF nullif(v_account->>'ledger_account','') IS NULL THEN CONTINUE; END IF;
    SELECT value INTO v_selection FROM jsonb_array_elements(p_selections) s WHERE s->>'uid' = v_account->>'uid';
    v_result := public.promote_psd2_cash_account(p_company_id, v_account || jsonb_build_object(
      'bank_connection_id', p_connection_id, 'external_uid', v_account->>'uid',
      'reuse_cash_account_id', v_selection->'reuse_cash_account_id', 'expected_session_id', v_connection.session_id));
    v_mirrors := v_mirrors || jsonb_build_array(v_result);
  END LOOP;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  RETURN jsonb_build_object('status', v_connection.status, 'accounts', v_connection.accounts_data, 'mirrors', v_mirrors);
END;
$function$;

REVOKE ALL ON FUNCTION public.bank_connection_configuration_state(jsonb) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bank_configuration_token(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.read_bank_configuration(uuid,uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bank_connection_configuration_state(jsonb) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.bank_configuration_token(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.read_bank_configuration(uuid,uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.guard_bank_configuration_writer() FROM PUBLIC, anon, authenticated;

NOTIFY pgrst, 'reload schema';
