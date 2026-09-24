-- Idempotent prerequisite for branches that have not replayed the older
-- event registration yet. Production already has this catalog entry.
INSERT INTO public.processing_event_types(event_type) VALUES ('CashAccountTwinsMerged')
ON CONFLICT (event_type) DO NOTHING;

CREATE OR REPLACE FUNCTION public.plan_cash_account_twins(p_company_id uuid)
RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_snapshot jsonb;
  v_groups jsonb := '[]';
  v_group record;
  v_keeper public.cash_accounts;
  v_live public.cash_accounts;
  v_row public.cash_accounts;
  v_posted text[];
  v_live_ids uuid[];
  v_ledger text;
  v_retired jsonb;
  v_report jsonb;
  v_skip text;
  v_movable integer;
  v_total integer;
  v_dependencies text[];
  v_changes boolean;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.companies WHERE id = p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- JSONB canonicalizes object keys; every array is explicitly ordered.
  -- Keep full relevant identity/configuration and reference sets in the hash,
  -- including transaction IDs (counts alone miss equal-count replacements).
  -- Balance observations and last-sync timestamps do not affect this plan.
  SELECT jsonb_build_object('version', 1, 'company', p_company_id,
    'cash', (SELECT coalesce(jsonb_agg(to_jsonb(c) - ARRAY['balance','available_balance','balance_updated_at','updated_at'] ORDER BY c.id), '[]')
      FROM public.cash_accounts c WHERE c.company_id = p_company_id),
    'connections', (SELECT coalesce(jsonb_agg(jsonb_build_object('id', b.id, 'session', b.session_id,
      'status', b.status, 'superseded', b.superseded_by, 'accounts', (
        SELECT coalesce(jsonb_agg(a - ARRAY['balance','available_balance','balance_updated_at','accepted_history_days'] ORDER BY a->>'uid'), '[]')
        FROM jsonb_array_elements(b.accounts_data) a)) ORDER BY b.id), '[]')
      FROM public.bank_connections b WHERE b.company_id = p_company_id),
    'transactions', (SELECT coalesce(jsonb_agg(to_jsonb(t) - 'updated_at' ORDER BY t.id), '[]')
      FROM public.transactions t WHERE t.company_id = p_company_id AND t.cash_account_id IS NOT NULL),
    'voucher_links', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.transaction_voucher_links a WHERE a.company_id = p_company_id),
    'invoice_payments', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.invoice_payments a WHERE a.company_id = p_company_id),
    'supplier_payments', (SELECT coalesce(jsonb_agg(to_jsonb(a) - 'updated_at' ORDER BY a.id), '[]')
      FROM public.supplier_invoice_payments a WHERE a.company_id = p_company_id),
    'posted_lines', (SELECT coalesce(jsonb_agg(jsonb_build_array(e.id, e.status, l.id, l.account_number) ORDER BY e.id, l.id), '[]')
      FROM public.journal_entries e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = p_company_id AND e.status IN ('posted','reversed') AND EXISTS (
        SELECT 1 FROM public.cash_accounts c WHERE c.company_id = p_company_id AND c.ledger_account = l.account_number)),
    'invoice_defaults', (SELECT coalesce(jsonb_agg(to_jsonb(d) - 'updated_at' ORDER BY d.id), '[]')
      FROM public.invoice_payee_defaults d WHERE d.company_id = p_company_id),
    'invoice_references', (SELECT coalesce(jsonb_agg(jsonb_build_array(i.id, i.payment_cash_account_id) ORDER BY i.id), '[]')
      FROM public.invoices i WHERE i.company_id = p_company_id AND i.payment_cash_account_id IS NOT NULL),
    'reconciliations', (SELECT coalesce(jsonb_agg(jsonb_build_array(r.id, r.account_key) ORDER BY r.id), '[]')
      FROM public.account_reconciliations r WHERE r.company_id = p_company_id),
    'reconciliation_attachments', (SELECT coalesce(jsonb_agg(jsonb_build_array(r.id, r.account_key) ORDER BY r.id), '[]')
      FROM public.account_reconciliation_attachments r WHERE r.company_id = p_company_id)
  ) INTO v_snapshot;

  FOR v_group IN
    SELECT upper(regexp_replace(iban, '\s', '', 'g')) || ':' || upper(currency) AS physical_key,
      array_agg(id ORDER BY id) AS ids, array_agg(ledger_account ORDER BY ledger_account) AS ledgers
    FROM public.cash_accounts WHERE company_id = p_company_id
      AND nullif(regexp_replace(iban, '\s', '', 'g'), '') IS NOT NULL
    GROUP BY upper(regexp_replace(iban, '\s', '', 'g')) || ':' || upper(currency)
    HAVING count(*) > 1 ORDER BY 1
  LOOP
    v_skip := NULL;
    v_retired := '[]';
    v_keeper := NULL;
    v_live := NULL;
    v_ledger := NULL;
    SELECT coalesce(array_agg(DISTINCT l.account_number ORDER BY l.account_number), '{}') INTO v_posted
    FROM public.journal_entry_lines l JOIN public.journal_entries e ON e.id = l.journal_entry_id
    WHERE e.company_id = p_company_id AND e.status IN ('posted', 'reversed') AND l.account_number = ANY(v_group.ledgers);
    IF cardinality(v_posted) > 1 THEN
      v_skip := 'split-ledgers';
    ELSE
      SELECT * INTO v_keeper FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_group.ids)
        ORDER BY (ledger_account = ANY(v_posted)) DESC, is_primary DESC, created_at, id LIMIT 1;
      SELECT coalesce(array_agg(c.id ORDER BY c.id), '{}') INTO v_live_ids
      FROM public.cash_accounts c JOIN public.bank_connections b ON b.id = c.bank_connection_id AND b.company_id = c.company_id
      WHERE c.company_id = p_company_id AND c.id = ANY(v_group.ids) AND b.status = 'active'
        AND b.superseded_by IS NULL AND b.session_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(b.accounts_data) a WHERE a->>'uid' = c.external_uid);
      IF cardinality(v_live_ids) <> 1 THEN
        v_skip := CASE WHEN cardinality(v_live_ids) = 0 THEN 'no-live-row' ELSE 'several-live-rows' END;
      ELSE
        SELECT * INTO v_live FROM public.cash_accounts WHERE company_id = p_company_id AND id = v_live_ids[1];
        SELECT a->>'ledger_account' INTO v_ledger FROM public.bank_connections b,
          LATERAL jsonb_array_elements(b.accounts_data) a
          WHERE b.company_id = p_company_id AND b.id = v_live.bank_connection_id AND a->>'uid' = v_live.external_uid;
        IF (SELECT count(*) FROM public.bank_connections b, LATERAL jsonb_array_elements(b.accounts_data) a
          WHERE b.company_id = p_company_id AND b.id = v_live.bank_connection_id AND a->>'uid' = v_live.external_uid) <> 1
          OR EXISTS (SELECT 1 FROM public.bank_connections b, LATERAL jsonb_array_elements(b.accounts_data) a
          WHERE b.company_id = p_company_id AND b.id = v_live.bank_connection_id AND a->>'uid' = v_live.external_uid
            AND (upper(a->>'currency') IS DISTINCT FROM v_live.currency OR
              (nullif(a->>'iban', '') IS NOT NULL AND upper(regexp_replace(a->>'iban', '\s', '', 'g'))
                IS DISTINCT FROM upper(regexp_replace(v_live.iban, '\s', '', 'g')))))
        THEN
          v_skip := 'identity-mismatch';
        ELSIF v_ledger IS NOT NULL AND NOT v_ledger = ANY(v_group.ledgers) THEN
          v_skip := 'routing-outside-group';
        END IF;
      END IF;
    END IF;
    IF v_skip IS NULL THEN
      v_changes := v_live.id <> v_keeper.id OR v_ledger IS DISTINCT FROM v_keeper.ledger_account;
      FOR v_row IN SELECT * FROM public.cash_accounts WHERE company_id = p_company_id
        AND id = ANY(v_group.ids) AND id <> v_keeper.id ORDER BY ledger_account, id
      LOOP
        SELECT count(*), count(*) FILTER (WHERE public.cash_transaction_is_movable(p_company_id, t.id))
          INTO v_total, v_movable FROM public.transactions t
          WHERE t.company_id = p_company_id AND t.cash_account_id = v_row.id;
        v_dependencies := public.cash_account_retirement_dependencies(p_company_id, v_row.id);
        IF cardinality(v_dependencies) > 0 THEN v_skip := 'retirement-dependencies'; END IF;
        v_retired := v_retired || jsonb_build_array(jsonb_build_object('id', v_row.id, 'ledger_account', v_row.ledger_account,
          'movable', v_movable, 'staying', v_total - v_movable, 'dependencies', v_dependencies,
          'outcome', CASE WHEN v_row.bank_connection_id IS NULL THEN 'kept-manual'
            WHEN v_total > v_movable THEN 'demoted-to-manual' ELSE 'deleted' END));
        v_changes := v_changes OR v_row.is_primary OR v_movable > 0 OR v_row.bank_connection_id IS NOT NULL;
      END LOOP;
      IF v_skip IS NULL AND NOT v_changes THEN v_skip := 'already-merged'; END IF;
    END IF;
    v_report := jsonb_build_object('physicalKey', v_group.physical_key, 'ledgers', v_group.ledgers,
      'postedLedgers', v_posted, 'skipped', v_skip,
      'keeper', CASE WHEN v_keeper.id IS NOT NULL THEN jsonb_build_object('id', v_keeper.id, 'ledger_account', v_keeper.ledger_account) END,
      'liveRowId', v_live.id, 'accountsDataLedgerFrom', CASE WHEN v_ledger IS DISTINCT FROM v_keeper.ledger_account THEN v_ledger END,
      'retired', v_retired);
    v_groups := v_groups || jsonb_build_array(v_report);
  END LOOP;
  RETURN jsonb_build_object('companyId', p_company_id, 'dryRun', true, 'groups', v_groups,
    'fingerprint', encode(sha256(convert_to(v_snapshot::text, 'UTF8')), 'hex'));
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
  -- A receipt contains IDs and ledger identifiers, never an IBAN. It remains
  -- discoverable by operation ID after the final twin is gone.
  SELECT coalesce(jsonb_agg(a - 'physicalKey'), '[]') INTO v_receipt_groups FROM jsonb_array_elements(v_plan->'groups') a;
  v_result := (v_plan - 'groups') || jsonb_build_object('dryRun', false, 'groups', v_receipt_groups, 'operationId', p_operation_id);
  INSERT INTO public.processing_history(event_id, company_id, correlation_id, aggregate_type, aggregate_id,
    event_type, payload, payload_schema_version, actor, occurred_at)
  VALUES (p_operation_id, p_company_id, p_operation_id, 'System', p_company_id, 'CashAccountTwinsMerged',
    jsonb_build_object('phase', 'completed', 'plan_fingerprint', p_expected_fingerprint, 'result', v_result), 2, p_actor, clock_timestamp());
  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.plan_cash_account_twins(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.heal_cash_account_twins(uuid, text, uuid, jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.plan_cash_account_twins(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.heal_cash_account_twins(uuid, text, uuid, jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
