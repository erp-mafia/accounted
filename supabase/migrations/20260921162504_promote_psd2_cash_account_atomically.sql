-- One transaction owns promotion, transaction rebinding, retirement, routing
-- and primary transfer. The company healer calls this same entry point.
CREATE OR REPLACE FUNCTION public.cash_transaction_is_movable(p_company_id uuid, p_transaction_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.transactions t
    WHERE t.id = p_transaction_id AND t.company_id = p_company_id
      AND t.journal_entry_id IS NULL AND t.invoice_id IS NULL AND t.supplier_invoice_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM public.transaction_voucher_links a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM public.invoice_payments a WHERE a.transaction_id = t.id)
      AND NOT EXISTS (SELECT 1 FROM public.supplier_invoice_payments a WHERE a.transaction_id = t.id)
  );
$$;

-- Transactions are handled separately: anchored rows retain their cash row.
-- These other dependencies make automatic retirement ambiguous, even when
-- the transaction count is zero. Do not rely on CASCADE or SET NULL cleanup.
CREATE OR REPLACE FUNCTION public.cash_account_retirement_dependencies(p_company_id uuid, p_cash_account_id uuid)
RETURNS text[]
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = ''
AS $$
  SELECT array_remove(ARRAY[
    CASE WHEN c.invoice_payee OR EXISTS (
      SELECT 1 FROM jsonb_each_text(to_jsonb(c)) f
      WHERE f.key = ANY (ARRAY['payee_iban','bank_name','clearing_number','account_number',
        'bankgiro','plusgiro','swish','bic','bank_code','foreign_account_number'])
        AND nullif(btrim(f.value), '') IS NOT NULL
    ) THEN 'invoice-configuration' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.invoice_payee_defaults d
      WHERE d.company_id = p_company_id AND d.cash_account_id = c.id) THEN 'invoice-default' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.invoices i
      WHERE i.company_id = p_company_id AND i.payment_cash_account_id = c.id) THEN 'invoice-reference' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.account_reconciliations r
      WHERE r.company_id = p_company_id AND r.account_key = 'bank:' || c.id::text) THEN 'reconciliation' END,
    CASE WHEN EXISTS (SELECT 1 FROM public.account_reconciliation_attachments r
      WHERE r.company_id = p_company_id AND r.account_key = 'bank:' || c.id::text) THEN 'reconciliation-attachment' END
  ], NULL)
  FROM public.cash_accounts c WHERE c.company_id = p_company_id AND c.id = p_cash_account_id;
$$;

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
BEGIN
  IF jsonb_typeof(p_input) IS DISTINCT FROM 'object' OR p_company_id IS NULL
    OR v_connection_id IS NULL OR v_uid IS NULL OR v_currency IS NULL
    OR v_currency !~ '^[A-Z]{3}$' OR v_ledger IS NULL OR v_ledger !~ '^[0-9]{4}$'
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_PROMOTION_INVALID_INPUT' USING ERRCODE = '22023';
  END IF;

  -- Identity writers serialize per company. Connection-before-cash matches
  -- the bank insertion RPC; no provider HTTP request holds these locks.
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_connection FROM public.bank_connections
    WHERE company_id = p_company_id AND id = v_connection_id;
  IF NOT FOUND OR v_connection.status NOT IN ('active', 'error', 'pending_selection')
    OR v_connection.superseded_by IS NOT NULL OR v_connection.session_id IS NULL
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_CONNECTION_CHANGED' USING ERRCODE = '40001';
  END IF;
  IF p_input ? 'expected_session_id'
    AND v_connection.session_id IS DISTINCT FROM p_input->>'expected_session_id'
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_SESSION_CHANGED' USING ERRCODE = '40001';
  END IF;
  SELECT count(*) INTO v_entry_count FROM jsonb_array_elements(v_connection.accounts_data) a
    WHERE a->>'uid' = v_uid;
  SELECT a INTO v_entry FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_uid;
  IF v_entry_count <> 1 OR upper(v_entry->>'currency') IS DISTINCT FROM v_currency
    OR (nullif(v_entry->>'iban', '') IS NOT NULL AND
      nullif(upper(regexp_replace(v_entry->>'iban', '\s', '', 'g')), '') IS DISTINCT FROM v_iban)
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_IDENTITY_CHANGED' USING ERRCODE = '40001';
  END IF;

  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_holder FROM public.cash_accounts
    WHERE company_id = p_company_id AND ledger_account = v_ledger;
  SELECT * INTO v_own FROM public.cash_accounts
    WHERE company_id = p_company_id AND bank_connection_id = v_connection_id AND external_uid = v_uid;

  IF v_reuse IS NOT NULL AND v_holder.id IS DISTINCT FROM v_reuse THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_KEEPER_CHANGED' USING ERRCODE = '40001';
  END IF;
  IF v_holder.id IS NOT NULL THEN
    v_row_iban := nullif(upper(regexp_replace(v_holder.iban, '\s', '', 'g')), '');
    IF v_holder.currency <> v_currency OR (v_row_iban IS NOT NULL AND v_row_iban IS DISTINCT FROM v_iban) THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_KEEPER_IDENTITY_CONFLICT' USING ERRCODE = '23514';
    END IF;
    IF v_holder.bank_connection_id IS NOT NULL AND v_holder.id IS DISTINCT FROM v_own.id
      AND v_holder.id IS DISTINCT FROM v_reuse
      AND NOT EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.company_id = p_company_id AND b.id = v_holder.bank_connection_id AND b.status = 'revoked')
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_LEDGER_CLAIMED' USING ERRCODE = '23505';
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
  IF EXISTS (SELECT 1 FROM unnest(v_retire_ids) id WHERE NOT EXISTS (
    SELECT 1 FROM public.cash_accounts c WHERE c.id = id AND c.company_id = p_company_id))
  THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_CHANGED' USING ERRCODE = '40001';
  END IF;
  -- Lock every source transaction before evaluating any anchor predicate.
  PERFORM 1 FROM public.transactions WHERE company_id = p_company_id AND cash_account_id = ANY(v_retire_ids)
    ORDER BY id FOR UPDATE;
  FOR v_retired IN SELECT * FROM public.cash_accounts WHERE company_id = p_company_id AND id = ANY(v_retire_ids) ORDER BY id LOOP
    IF v_iban IS NULL OR v_retired.currency <> v_currency OR
      nullif(upper(regexp_replace(v_retired.iban, '\s', '', 'g')), '') IS DISTINCT FROM v_iban
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT' USING ERRCODE = '23514';
    END IF;
    IF cardinality(public.cash_account_retirement_dependencies(p_company_id, v_retired.id)) > 0 THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES' USING ERRCODE = '23514';
    END IF;
    IF v_retired.id IS DISTINCT FROM v_own.id AND EXISTS (
      SELECT 1 FROM public.bank_connections b, LATERAL jsonb_array_elements(b.accounts_data) a
      WHERE b.company_id = p_company_id AND b.id = v_retired.bank_connection_id
        AND b.status IN ('active', 'error', 'pending_selection') AND b.superseded_by IS NULL
        AND a->>'uid' = v_retired.external_uid
    ) THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_STILL_LIVE' USING ERRCODE = '23514';
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
    RAISE EXCEPTION 'CASH_ACCOUNT_KEEPER_CHANGED' USING ERRCODE = '40001';
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

REVOKE ALL ON FUNCTION public.cash_transaction_is_movable(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.cash_account_retirement_dependencies(uuid, uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.promote_psd2_cash_account(uuid, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cash_transaction_is_movable(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.cash_account_retirement_dependencies(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.promote_psd2_cash_account(uuid, jsonb, uuid[]) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
