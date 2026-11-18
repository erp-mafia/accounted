-- Moving a bank account onto the ledger a manual or released row holds no
-- longer fails over a reconciliation sign-off, and every refusal on the way
-- names the bank account it is about (crm#1021).
--
-- What happened. A bank account was mirrored onto 1931 next to the 1930 row
-- every company is seeded with (an allocator rule fixed since, crm#129). The
-- imported history is on 1930, so the user moved the account there in the
-- bank picker. 1930 is held by the seeded manual row, so the save goes
-- through keeper adoption: promote_psd2_cash_account binds the account to
-- the 1930 row and retires the account's own row on 1931. Both rows had
-- been reconciled ("Markera som avstämd"), and the retirement refused any
-- row with a sign-off:
-- CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES under SQLSTATE 23514, a name the
-- error registry did not know, so the picker said "Förfrågan innehåller
-- ogiltiga uppgifter" and nothing could move the account. An account
-- without an IBAN failed the same retirement one step earlier, with
-- CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT.
--
-- What changes. save_bank_account_selection passes user_chosen_ledger to
-- promote_psd2_cash_account. With it, and only for the account's own row
-- (same connection and uid):
--   * a sign-off does not hold the retirement back. account_reconciliations
--     is append-only history: its rows are never rewritten, re-keyed or
--     deleted here. A row that still has booked transactions is demoted to
--     a manual row on its old ledger as before, so its sign-offs keep
--     resolving; a row with nothing left is deleted, and its sign-offs stay
--     in the table under the retired key, the state the table was designed
--     for (20260823140000: "the sign-off stays as history").
--   * the row passes the keeper identity rule (no IBAN, or the same one)
--     instead of requiring a matching IBAN on both sides.
-- Reconciliation attachments and invoice ties still refuse, and every other
-- caller (callback, renewal, twin repair) keeps the strict rules: those are
-- automatic and must not decide what history goes where.
--
-- Every refusal that is about another row (keeper identity, a ledger another
-- connection syncs, a yielding row with history, a retirement) now carries a
-- DETAIL naming that row: ledger, cash account id, name, the last four IBAN
-- characters, currency, and its bank connection's bank name and liveness. The
-- application turns it into a sentence that names the account and says what
-- to do. Rows of revoked connections, superseded ones included (supersession
-- revokes in the same statement, 20260921201948), already count as released.
--
-- Everything else in both functions is byte-identical to 20260921173226 (with
-- the PT409 codes of 20260921174642) and 20260929220300.
--
-- pg-test: covered-by tests/pg/bank-account-selection.pg.test.ts

CREATE OR REPLACE FUNCTION public.cash_account_refusal_detail(
  p_company_id uuid, p_cash_account_id uuid, p_ledger_account text, p_dependencies text[] DEFAULT NULL
)
RETURNS text
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'ledger_account', p_ledger_account,
    'dependencies', to_jsonb(p_dependencies),
    'cash_account', (
      SELECT jsonb_build_object(
        'id', c.id,
        'ledger_account', c.ledger_account,
        'name', nullif(btrim(c.name), ''),
        'iban_last4', right(nullif(upper(regexp_replace(c.iban, '\s', '', 'g')), ''), 4),
        'currency', c.currency,
        'enabled', c.enabled,
        'bank_connection_id', c.bank_connection_id,
        'bank_name', nullif(btrim(b.bank_name), ''),
        'connection_status', b.status,
        'connection_live', b.id IS NOT NULL AND b.status <> 'revoked' AND b.superseded_by IS NULL)
      FROM public.cash_accounts c
      LEFT JOIN public.bank_connections b ON b.company_id = c.company_id AND b.id = c.bank_connection_id
      WHERE c.company_id = p_company_id AND c.id = p_cash_account_id)))::text;
$function$;

REVOKE ALL ON FUNCTION public.cash_account_refusal_detail(uuid, uuid, text, text[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_account_refusal_detail(uuid, uuid, text, text[]) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.promote_psd2_cash_account(
  p_company_id uuid,
  p_input jsonb,
  p_retire_cash_account_ids uuid[] DEFAULT '{}'
)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_connection_id uuid := (p_input->>'bank_connection_id')::uuid;
  v_uid text := nullif(p_input->>'external_uid', '');
  v_currency text := upper(p_input->>'currency');
  v_ledger text := p_input->>'ledger_account';
  v_iban text := nullif(upper(regexp_replace(p_input->>'iban', '\s', '', 'g')), '');
  v_reuse uuid := nullif(p_input->>'reuse_cash_account_id', '')::uuid;
  v_connection public.bank_connections;
  v_holder public.cash_accounts;
  v_own public.cash_accounts;
  v_retired public.cash_accounts;
  v_target uuid;
  v_entry jsonb;
  v_entry_count integer;
  v_retire_ids uuid[];
  v_moved integer := 0;
  v_count integer;
  v_primary boolean := false;
  v_retirement jsonb := '[]';
  v_outcome text;
  v_row_iban text;
  -- Set by save_bank_account_selection only: the user picked this ledger for
  -- the account in the bank picker. Every other caller keeps the strict rules.
  v_user_chosen boolean := coalesce(p_input->'user_chosen_ledger' = 'true'::jsonb, false);
  v_dependencies text[];
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_company_id IS NULL
    OR v_connection_id IS NULL OR v_uid IS NULL OR v_currency IS NULL
    OR v_currency !~ '^[A-Z]{3}$' OR v_ledger IS NULL OR v_ledger !~ '^[0-9]{4}$'
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PROMOTION_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  -- Identity writers serialize per company. Connection-before-cash matches
  -- the bank insertion RPC; no provider HTTP request holds these locks.
  PERFORM public.lock_cash_account_company(p_company_id);
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_connection FROM public.bank_connections
    WHERE company_id = p_company_id AND id = v_connection_id;
  IF NOT FOUND OR v_connection.status NOT IN ('active', 'error', 'pending_selection')
    OR v_connection.superseded_by IS NOT NULL OR v_connection.session_id IS NULL
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_CONNECTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF p_input ? 'expected_session_id'
    AND v_connection.session_id IS DISTINCT FROM p_input->>'expected_session_id'
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_SESSION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  SELECT count(*) INTO v_entry_count FROM jsonb_array_elements(v_connection.accounts_data) a
    WHERE a->>'uid' = v_uid;
  SELECT a INTO v_entry FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_uid;
  IF v_entry_count <> 1 OR upper(v_entry->>'currency') IS DISTINCT FROM v_currency
    OR (nullif(v_entry->>'iban', '') IS NOT NULL AND
      nullif(upper(regexp_replace(v_entry->>'iban', '\s', '', 'g')), '') IS DISTINCT FROM v_iban)
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_IDENTITY_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_holder FROM public.cash_accounts
    WHERE company_id = p_company_id AND ledger_account = v_ledger;
  SELECT * INTO v_own FROM public.cash_accounts
    WHERE company_id = p_company_id AND bank_connection_id = v_connection_id AND external_uid = v_uid;

  IF v_reuse IS NOT NULL AND v_holder.id IS DISTINCT FROM v_reuse THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_KEEPER_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF v_holder.id IS NOT NULL THEN
    v_row_iban := nullif(upper(regexp_replace(v_holder.iban, '\s', '', 'g')), '');
    IF v_holder.currency <> v_currency OR (v_row_iban IS NOT NULL AND v_row_iban IS DISTINCT FROM v_iban) THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT' USING ERRCODE = '23514',
        DETAIL = public.cash_account_refusal_detail(p_company_id, v_holder.id, v_ledger);
    END IF;
    IF v_holder.bank_connection_id IS NOT NULL AND v_holder.id IS DISTINCT FROM v_own.id
      AND v_holder.id IS DISTINCT FROM v_reuse
      AND NOT EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.company_id = p_company_id AND b.id = v_holder.bank_connection_id AND b.status = 'revoked')
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_LEDGER_CLAIMED' USING ERRCODE = '23505',
        DETAIL = public.cash_account_refusal_detail(p_company_id, v_holder.id, v_ledger);
    END IF;
    v_target := v_holder.id;
  ELSIF v_own.id IS NOT NULL THEN
    -- Changing the BAS number on an existing row would change the meaning of
    -- its historical bindings. Only a genuinely unused row can change slots.
    IF EXISTS (SELECT 1 FROM public.transactions WHERE company_id = p_company_id AND cash_account_id = v_own.id)
      OR cardinality(public.cash_account_retirement_dependencies(p_company_id, v_own.id)) > 0
      OR EXISTS (SELECT 1 FROM public.journal_entry_lines l JOIN public.journal_entries e ON e.id = l.journal_entry_id
        WHERE e.company_id = p_company_id AND e.status IN ('posted', 'reversed') AND l.account_number = v_own.ledger_account)
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_LEDGER_IN_USE' USING ERRCODE = '23514';
    END IF;
    v_target := v_own.id;
  ELSE
    INSERT INTO public.cash_accounts(company_id, bank_connection_id, external_uid, currency, ledger_account, iban)
    VALUES (p_company_id, v_connection_id, v_uid, v_currency, v_ledger, p_input->>'iban')
    RETURNING id INTO v_target;
  END IF;

  SELECT coalesce(array_agg(DISTINCT id ORDER BY id), '{}') INTO v_retire_ids
  FROM unnest(coalesce(p_retire_cash_account_ids, '{}') || ARRAY[v_own.id]) id
  WHERE id IS NOT NULL AND id <> v_target;
  IF EXISTS (SELECT 1 FROM unnest(v_retire_ids) AS requested(id) WHERE NOT EXISTS (
    SELECT 1 FROM public.cash_accounts c WHERE c.id = requested.id AND c.company_id = p_company_id))
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  -- Lock every source transaction before evaluating any anchor predicate.
  PERFORM 1 FROM public.transactions WHERE company_id = p_company_id AND cash_account_id = ANY(v_retire_ids)
    ORDER BY id FOR UPDATE;
  FOR v_retired IN SELECT * FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_retire_ids) ORDER BY id LOOP
    -- The account's own row (same connection and uid) is the account itself.
    -- When the user picked the ledger it only has to pass the keeper rule (no
    -- IBAN, or the same one), so an account without an IBAN can move as well.
    IF v_retired.currency <> v_currency OR (CASE WHEN v_user_chosen AND v_retired.id = v_own.id
        THEN nullif(upper(regexp_replace(v_retired.iban, '\s', '', 'g')), '') IS NOT NULL
          AND nullif(upper(regexp_replace(v_retired.iban, '\s', '', 'g')), '') IS DISTINCT FROM v_iban
        ELSE v_iban IS NULL
          OR nullif(upper(regexp_replace(v_retired.iban, '\s', '', 'g')), '') IS DISTINCT FROM v_iban END)
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT' USING ERRCODE = '23514',
        DETAIL = public.cash_account_refusal_detail(p_company_id, v_retired.id, v_ledger);
    END IF;
    -- A sign-off is append-only history: it never holds back a move the user
    -- asked for and stays, unchanged, under the retired row's key. Reconciliation
    -- attachments (underlag) and invoice ties still refuse, as everywhere else.
    v_dependencies := public.cash_account_retirement_dependencies(p_company_id, v_retired.id);
    IF v_user_chosen AND v_retired.id = v_own.id THEN
      v_dependencies := array_remove(v_dependencies, 'reconciliation');
    END IF;
    IF cardinality(v_dependencies) > 0 THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES' USING ERRCODE = '23514',
        DETAIL = public.cash_account_refusal_detail(p_company_id, v_retired.id, v_ledger, v_dependencies);
    END IF;
    IF v_retired.id IS DISTINCT FROM v_own.id AND EXISTS (
      SELECT 1 FROM public.bank_connections b, LATERAL jsonb_array_elements(b.accounts_data) a
      WHERE b.company_id = p_company_id AND b.id = v_retired.bank_connection_id
        AND b.status IN ('active', 'error', 'pending_selection') AND b.superseded_by IS NULL
        AND a->>'uid' = v_retired.external_uid
    ) THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_STILL_LIVE' USING ERRCODE = '23514',
        DETAIL = public.cash_account_refusal_detail(p_company_id, v_retired.id, v_ledger);
    END IF;
    v_primary := v_primary OR v_retired.is_primary;
    UPDATE public.transactions t SET cash_account_id = v_target
      WHERE t.company_id = p_company_id AND t.cash_account_id = v_retired.id
        AND public.cash_transaction_is_movable(p_company_id, t.id);
    GET DIAGNOSTICS v_count = ROW_COUNT;
    v_moved := v_moved + v_count;
    IF v_retired.bank_connection_id IS NULL THEN
      v_outcome := 'kept-manual';
    ELSIF EXISTS (SELECT 1 FROM public.transactions WHERE company_id = p_company_id AND cash_account_id = v_retired.id) THEN
      UPDATE public.cash_accounts SET bank_connection_id = NULL, external_uid = NULL
        WHERE company_id = p_company_id AND id = v_retired.id;
      v_outcome := 'demoted-to-manual';
    ELSE
      DELETE FROM public.cash_accounts WHERE company_id = p_company_id AND id = v_retired.id;
      v_outcome := 'deleted';
    END IF;
    v_retirement := v_retirement || jsonb_build_array(jsonb_build_object('id', v_retired.id,
      'ledger_account', v_retired.ledger_account, 'outcome', v_outcome, 'moved', v_count));
  END LOOP;

  UPDATE public.cash_accounts c SET
    bank_connection_id = v_connection_id, external_uid = v_uid, currency = v_currency, ledger_account = v_ledger,
    iban = coalesce(p_input->>'iban', c.iban), bban = coalesce(nullif(p_input->>'bban', ''), c.bban),
    name = coalesce(p_input->>'name', c.name), enabled = coalesce((p_input->>'enabled')::boolean, c.enabled),
    source = 'enable_banking'
    WHERE c.company_id = p_company_id AND c.id = v_target;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_KEEPER_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  -- A stale configuration response must not replace a newer balance.
  IF nullif(p_input->>'balance_updated_at', '') IS NOT NULL THEN
    UPDATE public.cash_accounts c SET
      balance = CASE WHEN p_input ? 'balance' THEN (p_input->>'balance')::numeric ELSE c.balance END,
      available_balance = CASE WHEN p_input ? 'available_balance' THEN (p_input->>'available_balance')::numeric ELSE c.available_balance END,
      balance_updated_at = (p_input->>'balance_updated_at')::timestamptz
    WHERE c.company_id = p_company_id AND c.id = v_target
      AND (c.balance_updated_at IS NULL OR c.balance_updated_at <= (p_input->>'balance_updated_at')::timestamptz);
  END IF;
  IF v_primary THEN
    PERFORM public.set_cash_account_primary(p_company_id, v_target);
  END IF;
  UPDATE public.bank_connections b SET accounts_data = (
    SELECT jsonb_agg(CASE WHEN a->>'uid' = v_uid THEN
      a || jsonb_build_object('ledger_account', v_ledger, 'enabled', c.enabled) ELSE a END ORDER BY n)
    FROM jsonb_array_elements(b.accounts_data) WITH ORDINALITY x(a, n)
    CROSS JOIN public.cash_accounts c WHERE c.company_id = p_company_id AND c.id = v_target
  ) WHERE b.company_id = p_company_id AND b.id = v_connection_id;

  RETURN jsonb_build_object('cashAccountId', v_target, 'moved', v_moved, 'retired', v_retirement);
END;
$$;

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
  v_yield public.cash_accounts; v_carry_primary text; v_yielded jsonb := '[]';
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

  -- An account that yields its ledger (unchecked in this save, or unchecked
  -- in another live connection) to a checked account of another physical
  -- account gives up its row. Promotion cannot adopt that row, and detaching
  -- it would leave the other account's IBAN on the ledger. See the header.
  -- An unchecked account that asks for a ledger of its own is not yielding:
  -- the move step below relocates its row in place.
  FOR v_yield IN
    SELECT c.* FROM public.cash_accounts c
    WHERE c.company_id = p_company_id AND c.bank_connection_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.bank_connections b WHERE b.id = c.bank_connection_id AND b.status = 'revoked')
      AND ((c.bank_connection_id = p_connection_id AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_selections) u
            WHERE u->>'uid' = c.external_uid AND NOT (u->>'enabled')::boolean
              AND nullif(u->>'ledger_account','') IS NULL))
        OR (c.bank_connection_id <> p_connection_id AND c.enabled = false))
      AND EXISTS (SELECT 1 FROM jsonb_array_elements(p_selections) s
        JOIN jsonb_array_elements(v_connection.accounts_data) a ON a->>'uid' = s->>'uid'
        WHERE (s->>'enabled')::boolean AND s->>'ledger_account' = c.ledger_account
          AND c.id IS DISTINCT FROM nullif(s->>'reuse_cash_account_id','')::uuid
          -- promote_psd2_cash_account's keeper identity rule, negated.
          AND (c.currency <> upper(a->>'currency')
            OR (nullif(upper(regexp_replace(c.iban, '\s', '', 'g')), '') IS NOT NULL
              AND nullif(upper(regexp_replace(c.iban, '\s', '', 'g')), '')
                IS DISTINCT FROM nullif(upper(regexp_replace(a->>'iban', '\s', '', 'g')), ''))))
    ORDER BY c.id
  LOOP
    IF EXISTS (SELECT 1 FROM public.transactions t WHERE t.company_id = p_company_id AND t.cash_account_id = v_yield.id)
      OR cardinality(public.cash_account_retirement_dependencies(p_company_id, v_yield.id)) > 0 THEN
      RAISE EXCEPTION 'BANK_SELECTION_YIELD_HAS_HISTORY' USING ERRCODE = '23514',
        DETAIL = public.cash_account_refusal_detail(p_company_id, v_yield.id, v_yield.ledger_account);
    END IF;
    IF v_yield.is_primary THEN v_carry_primary := v_yield.ledger_account; END IF;
    DELETE FROM public.cash_accounts WHERE company_id = p_company_id AND id = v_yield.id;
    v_yielded := v_yielded || jsonb_build_array(jsonb_build_object('id', v_yield.id,
      'ledger_account', v_yield.ledger_account, 'bank_connection_id', v_yield.bank_connection_id,
      'is_primary', v_yield.is_primary));
  END LOOP;

  -- A cash account row is the bank account (connection + uid), not its BAS
  -- number. An account of this connection that asks for another ledger keeps
  -- its row, transactions and primary flag; only ledger_account changes. That
  -- applies when the wanted ledger is free once every such move is done, which
  -- covers chains (A 1931->1930 while B 1935->1931) and swaps. A ledger held
  -- by any row that stays put (manual, another connection, a yielding row
  -- promotion can adopt) keeps the release and promotion rules below.
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
      'reuse_cash_account_id', v_selection->'reuse_cash_account_id', 'expected_session_id', v_connection.session_id,
      'user_chosen_ledger', true));
    v_mirrors := v_mirrors || jsonb_build_array(v_result);
  END LOOP;
  -- A deleted yielding row's primary flag follows its ledger.
  IF v_carry_primary IS NOT NULL THEN
    PERFORM public.set_cash_account_primary(p_company_id, (SELECT c.id FROM public.cash_accounts c
      WHERE c.company_id = p_company_id AND c.ledger_account = v_carry_primary));
  END IF;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  RETURN jsonb_build_object('status', v_connection.status, 'accounts', v_connection.accounts_data, 'mirrors', v_mirrors,
    'yielded', v_yielded);
END;
$function$;

REVOKE ALL ON FUNCTION public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.save_bank_account_selection(uuid,uuid,uuid,text,jsonb,jsonb) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
