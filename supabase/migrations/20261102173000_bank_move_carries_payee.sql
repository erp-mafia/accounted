-- Moving a bank account onto the ledger its history is on no longer stops at
-- the invoice payee details of the account's own row (crm#1445).
--
-- What happened. A bank account's history was imported from a bank file onto
-- a manual row on 1932, and booked there. The bank was then connected, and the
-- account got its own row on 1931; connecting made that row the company's
-- invoice payee (its IBAN, clearing and account number, BIC) and the SEK payee
-- default. The bank-file rows and the feed's rows were never compared (the
-- ingest dedup only compares rows of one physical account, and the manual row
-- has no IBAN), so the feed stored copies of booked rows on 1931. The user
-- moved the account to 1932 in the bank settings, as the product intends:
-- save_bank_account_selection passes user_chosen_ledger, keeper adoption binds
-- the account to the 1932 row and retires the 1931 row. The retirement refused
-- with CASH_ACCOUNT_RETIREMENT_HAS_DEPENDENCIES (invoice-configuration and
-- invoice-default) and sent the user to support. The company had no invoices.
--
-- What changes. In promote_psd2_cash_account, for the account's own row when
-- the user picked the ledger (the crm#1021 branch, 20261005124500), the payee
-- details and the payee default move with the account onto the keeper instead
-- of refusing, when:
--   * the keeper has no payee details or default of its own (two sets would
--     have to be merged: that still refuses, naming the row);
--   * the ledger may be printed as payee (BAS 1920-1999), the floor
--     cash_accounts_payee_admin_only enforces;
--   * the caller may change the payee (no end user, or an owner/admin), the
--     same trigger's rule: a member still gets the refusal.
-- The defaults are re-pointed before the old row's flag is cleared, because
-- clearing the flag drops the defaults that row still holds
-- (trg_mirror_invoice_payee_defaults). The audit triggers on cash_accounts and
-- invoice_payee_defaults record both rows. Issued invoices that name the row
-- (invoice-reference) and reconciliation attachments still refuse, and every
-- other caller (callback, renewal, twin repair) keeps the strict rules.
--
-- Everything else in the function is byte-identical to its definition in
-- 20261101180000 (the definition live in production on 2026-11-02).
--
-- pg-test: covered-by tests/pg/bank-account-selection.pg.test.ts

CREATE OR REPLACE FUNCTION public.promote_psd2_cash_account(p_company_id uuid, p_input jsonb, p_retire_cash_account_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_connection_id uuid := (p_input->>'bank_connection_id')::uuid;
  v_uid text := nullif(p_input->>'external_uid', '');
  v_currency text := upper(p_input->>'currency');
  v_ledger text := p_input->>'ledger_account';
  v_iban text := public.normalize_iban(p_input->>'iban');
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
  v_carry_payee boolean;
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
      public.normalize_iban(v_entry->>'iban') IS DISTINCT FROM v_iban)
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
    v_row_iban := public.normalize_iban(v_holder.iban);
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
        THEN public.normalize_iban(v_retired.iban) IS NOT NULL
          AND public.normalize_iban(v_retired.iban) IS DISTINCT FROM v_iban
        ELSE v_iban IS NULL
          OR public.normalize_iban(v_retired.iban) IS DISTINCT FROM v_iban END)
    THEN
      RAISE EXCEPTION 'CASH_ACCOUNT_RETIREMENT_IDENTITY_CONFLICT' USING ERRCODE = '23514',
        DETAIL = public.cash_account_refusal_detail(p_company_id, v_retired.id, v_ledger);
    END IF;
    -- A sign-off is append-only history: it never holds back a move the user
    -- asked for and stays, unchanged, under the retired row's key. Reconciliation
    -- attachments (underlag) and invoice ties still refuse, as everywhere else.
    v_dependencies := public.cash_account_retirement_dependencies(p_company_id, v_retired.id);
    v_carry_payee := false;
    IF v_user_chosen AND v_retired.id = v_own.id THEN
      v_dependencies := array_remove(v_dependencies, 'reconciliation');
      -- The payee details and the payee default describe this bank account,
      -- so they move with it onto the keeper (crm#1445), when the keeper has
      -- none of its own, the ledger may be printed as payee (BAS 1920-1999)
      -- and the caller may change the payee: the rules of
      -- cash_accounts_payee_admin_only. Issued invoices naming the row still
      -- refuse.
      IF v_dependencies && ARRAY['invoice-configuration', 'invoice-default']
        AND v_ledger ~ '^19[2-9][0-9]$'
        AND (auth.uid() IS NULL OR public.user_is_company_admin(p_company_id))
        AND NOT (public.cash_account_retirement_dependencies(p_company_id, v_target)
          && ARRAY['invoice-configuration', 'invoice-default'])
      THEN
        v_dependencies := array_remove(array_remove(v_dependencies, 'invoice-configuration'), 'invoice-default');
        v_carry_payee := true;
      END IF;
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
    IF v_carry_payee THEN
      UPDATE public.cash_accounts t SET invoice_payee = s.invoice_payee,
          payee_iban = s.payee_iban, bank_name = s.bank_name, clearing_number = s.clearing_number,
          account_number = s.account_number, bankgiro = s.bankgiro, plusgiro = s.plusgiro, swish = s.swish,
          bic = s.bic, bank_code = s.bank_code, foreign_account_number = s.foreign_account_number
        FROM public.cash_accounts s
        WHERE t.company_id = p_company_id AND t.id = v_target AND s.company_id = p_company_id AND s.id = v_retired.id;
      -- Before the row lets go of the flag: clearing it drops the defaults it still holds.
      UPDATE public.invoice_payee_defaults SET cash_account_id = v_target
        WHERE company_id = p_company_id AND cash_account_id = v_retired.id;
      UPDATE public.cash_accounts SET invoice_payee = false, payee_iban = NULL, bank_name = NULL,
          clearing_number = NULL, account_number = NULL, bankgiro = NULL, plusgiro = NULL, swish = NULL,
          bic = NULL, bank_code = NULL, foreign_account_number = NULL
        WHERE company_id = p_company_id AND id = v_retired.id;
    END IF;
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
    source = v_connection.aggregator
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
$function$;
REVOKE ALL ON FUNCTION public.promote_psd2_cash_account(uuid, jsonb, uuid[]) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.promote_psd2_cash_account(uuid, jsonb, uuid[]) TO authenticated, service_role;
