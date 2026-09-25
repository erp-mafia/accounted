-- Changing which BAS account a bank account books to keeps its cash account
-- row. save_bank_account_selection released every row whose CURRENT ledger
-- another account of the same connection asked for, so a chain in one save
-- (A 1931->1930 while B 1935->1931) or a swap detached A's row, gave A a new
-- row and then refused B on the detached one (CASH_ACCOUNT_KEEPER_IDENTITY_
-- CONFLICT). Rows of this connection whose account moves are now re-ledgered
-- in place before releases are derived, so the release step no longer sees
-- them. Everything else is byte-identical to 20260921191040.
--
-- pg-test: covered-by tests/pg/bank-account-selection.pg.test.ts

CREATE OR REPLACE FUNCTION public.save_bank_account_selection(
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
  v_move_ids uuid[]; v_move_ledgers text[]; v_keep_ids uuid[]; v_keep_ledgers text[];
  v_done uuid[]; v_park text;
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

  -- A cash account row is the bank account (connection + uid), not its BAS
  -- number. An account of this connection that asks for another ledger keeps
  -- its row, transactions and primary flag; only ledger_account changes. That
  -- applies when the wanted ledger is free once every such move is done, which
  -- covers chains (A 1931->1930 while B 1935->1931) and swaps. A ledger held
  -- by any row that stays put (manual, another connection, an unchecked
  -- account that yields) keeps the release and promotion rules below.
  SELECT coalesce(array_agg(c.id ORDER BY c.id), '{}'), coalesce(array_agg(s->>'ledger_account' ORDER BY c.id), '{}')
    INTO v_move_ids, v_move_ledgers
  FROM public.cash_accounts c
  JOIN jsonb_array_elements(p_selections) s ON s->>'uid' = c.external_uid
  WHERE c.company_id = p_company_id AND c.bank_connection_id = p_connection_id
    AND nullif(s->>'ledger_account','') IS NOT NULL AND s->>'ledger_account' <> c.ledger_account
    AND nullif(s->>'reuse_cash_account_id','') IS NULL;
  LOOP
    SELECT coalesce(array_agg(m.id ORDER BY m.id), '{}'), coalesce(array_agg(m.ledger ORDER BY m.id), '{}')
      INTO v_keep_ids, v_keep_ledgers
    FROM unnest(v_move_ids, v_move_ledgers) m(id, ledger)
    WHERE NOT EXISTS (SELECT 1 FROM public.cash_accounts h WHERE h.company_id = p_company_id
      AND h.ledger_account = m.ledger AND NOT (h.id = ANY(v_move_ids)));
    EXIT WHEN cardinality(v_keep_ids) = cardinality(v_move_ids);
    v_move_ids := v_keep_ids; v_move_ledgers := v_keep_ledgers;
  END LOOP;
  -- UNIQUE (company_id, ledger_account) is checked row by row, so a move runs
  -- once its ledger is free. Only a closed cycle (a swap) blocks every move;
  -- one of its rows then waits on an unused 19xx number for a round.
  WHILE cardinality(v_move_ids) > 0 LOOP
    WITH ready AS (
      SELECT m.id, m.ledger FROM unnest(v_move_ids, v_move_ledgers) m(id, ledger)
      WHERE NOT EXISTS (SELECT 1 FROM public.cash_accounts h WHERE h.company_id = p_company_id AND h.ledger_account = m.ledger)
    ), moved AS (
      UPDATE public.cash_accounts c SET ledger_account = r.ledger FROM ready r
      WHERE c.company_id = p_company_id AND c.id = r.id RETURNING c.id
    ) SELECT coalesce(array_agg(id), '{}') INTO v_done FROM moved;
    IF cardinality(v_done) > 0 THEN
      SELECT coalesce(array_agg(m.id ORDER BY m.id), '{}'), coalesce(array_agg(m.ledger ORDER BY m.id), '{}')
        INTO v_move_ids, v_move_ledgers
      FROM unnest(v_move_ids, v_move_ledgers) m(id, ledger) WHERE NOT (m.id = ANY(v_done));
    ELSE
      SELECT g::text INTO v_park FROM generate_series(1999, 1920, -1) g
      WHERE NOT EXISTS (SELECT 1 FROM public.cash_accounts h WHERE h.company_id = p_company_id AND h.ledger_account = g::text)
      LIMIT 1;
      IF v_park IS NULL THEN RAISE EXCEPTION 'BANK_SELECTION_LEDGER_CONFLICT' USING ERRCODE = '23514'; END IF;
      UPDATE public.cash_accounts SET ledger_account = v_park WHERE company_id = p_company_id AND id = v_move_ids[1];
    END IF;
  END LOOP;

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

REVOKE ALL ON FUNCTION public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
