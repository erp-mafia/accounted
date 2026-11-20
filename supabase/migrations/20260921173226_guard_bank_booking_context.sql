-- Preserve the bank source snapshot until posting. A stale draft must fail
-- before its voucher number and any intended sibling move become durable.
ALTER TABLE public.journal_entries
  ADD COLUMN bank_booking_context jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD CONSTRAINT journal_entries_bank_booking_context_array
    CHECK (jsonb_typeof(bank_booking_context) = 'array');

CREATE INDEX journal_entries_posted_bank_context_idx
  ON public.journal_entries USING gin (bank_booking_context jsonb_path_ops)
  WHERE status = 'posted';
CREATE INDEX journal_entries_posted_bank_source_idx
  ON public.journal_entries (company_id, source_id)
  WHERE status = 'posted' AND source_type = 'bank_transaction';

-- A posted origin protects the source even before the later link request.
-- Reversals release this additional origin claim; existing explicit anchors
-- still prevent movement until their normal unlinking workflow has run.
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
      AND NOT EXISTS (
        SELECT 1 FROM public.journal_entries j WHERE j.company_id = p_company_id AND j.status = 'posted'
          AND ((j.source_type = 'bank_transaction' AND j.source_id = t.id)
            OR j.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', t.id)))
      )
  );
$$;

-- Company UPDATE policies are admin-only. Writers still need the same row
-- lock for bookkeeping. This narrow definer only locks an authorized company;
-- all business reads/writes remain under their existing invoker policies.
CREATE FUNCTION public.lock_cash_account_company(p_company_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF public.jwt_caller_is_end_user() AND NOT public.caller_can_write_company(p_company_id) THEN
    RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_WRITE_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.companies WHERE id = p_company_id FOR NO KEY UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_COMPANY_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
END;
$$;
REVOKE ALL ON FUNCTION public.lock_cash_account_company(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.lock_cash_account_company(uuid) TO authenticated, service_role;

CREATE FUNCTION public.guard_bank_booking_context()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE
  v_context jsonb;
  v_transaction public.transactions%ROWTYPE;
  v_cash public.cash_accounts%ROWTYPE;
  v_target public.cash_accounts%ROWTYPE;
  v_ledger text;
  v_count integer;
  v_target_id uuid;
  v_own_released boolean;
  v_target_live boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'reversed')
     AND NEW.bank_booking_context IS DISTINCT FROM OLD.bank_booking_context THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  IF NEW.status <> 'posted' OR (TG_OP = 'UPDATE' AND OLD.status = 'posted') THEN
    IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
       AND OLD.status IN ('posted', 'reversed') THEN
      PERFORM public.lock_cash_account_company(NEW.company_id);
    END IF;
    RETURN NEW;
  END IF;

  -- All posting participates in keeper-history serialization, including
  -- manual/import entries that do not originate from a bank transaction.
  PERFORM public.lock_cash_account_company(NEW.company_id);
  IF NEW.source_type = 'bank_transaction' AND (NEW.source_id IS NULL OR NOT (
    NEW.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', NEW.source_id))
  )) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  IF jsonb_array_length(NEW.bank_booking_context) = 0 THEN RETURN NEW; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.bank_booking_context) c
    WHERE jsonb_typeof(c) <> 'object'
       OR NOT (c ?& ARRAY['transaction_id','cash_account_id','settlement_account','date','amount','currency'])
       OR jsonb_typeof(c->'transaction_id') <> 'string'
       OR jsonb_typeof(c->'cash_account_id') NOT IN ('string','null')
       OR jsonb_typeof(c->'settlement_account') <> 'string'
       OR jsonb_typeof(c->'date') <> 'string'
       OR jsonb_typeof(c->'amount') <> 'number'
       OR jsonb_typeof(c->'currency') <> 'string'
       OR (c ? 'target_cash_account_id' AND jsonb_typeof(c->'target_cash_account_id') <> 'string')
  ) OR EXISTS (
    SELECT 1 FROM jsonb_array_elements(NEW.bank_booking_context) c
    GROUP BY c->>'transaction_id' HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_INVALID' USING ERRCODE = '23514';
  END IF;

  -- Same order as ingest and promotion. The company lock also serializes
  -- account creation/configuration once those writers use this protocol.
  PERFORM 1 FROM public.bank_connections WHERE company_id = NEW.company_id ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE;
  PERFORM 1 FROM public.transactions t WHERE t.company_id = NEW.company_id
    AND t.id IN (SELECT (c->>'transaction_id')::uuid FROM jsonb_array_elements(NEW.bank_booking_context) c)
    ORDER BY t.id FOR UPDATE;

  FOR v_context IN SELECT c FROM jsonb_array_elements(NEW.bank_booking_context) c ORDER BY c->>'transaction_id' LOOP
    SELECT * INTO v_transaction FROM public.transactions
      WHERE company_id = NEW.company_id AND id = (v_context->>'transaction_id')::uuid;
    IF NOT FOUND OR v_transaction.cash_account_id IS DISTINCT FROM (v_context->>'cash_account_id')::uuid
      OR v_transaction.date IS DISTINCT FROM (v_context->>'date')::date
      OR v_transaction.amount IS DISTINCT FROM (v_context->>'amount')::numeric
      OR v_transaction.currency IS DISTINCT FROM v_context->>'currency' THEN
      RAISE EXCEPTION 'BANK_BOOKING_SOURCE_CHANGED' USING ERRCODE = '40001';
    END IF;

    v_target_id := (v_context->>'target_cash_account_id')::uuid;
    IF v_target_id IS NOT NULL AND v_target_id IS DISTINCT FROM v_transaction.cash_account_id THEN
      SELECT * INTO v_cash FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id;
      SELECT * INTO v_target FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_target_id;
      IF v_cash.id IS NULL OR v_target.id IS NULL OR NOT v_target.enabled
        OR nullif(regexp_replace(upper(v_cash.iban), '\s', '', 'g'), '') IS NULL
        OR regexp_replace(upper(v_cash.iban), '\s', '', 'g') IS DISTINCT FROM regexp_replace(upper(v_target.iban), '\s', '', 'g')
        OR v_cash.currency IS DISTINCT FROM v_target.currency
        OR v_target.currency IS DISTINCT FROM v_transaction.currency
        OR NOT public.cash_transaction_is_movable(NEW.company_id, v_transaction.id) THEN
        RAISE EXCEPTION 'BANK_BOOKING_REBIND_REFUSED' USING ERRCODE = '23514';
      END IF;
      -- Match shouldRepointToSibling: live destination, or released source
      -- with no live sibling. Same-currency, enabled physical siblings only.
      v_target_live := EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.id = v_target.bank_connection_id AND b.company_id = NEW.company_id AND b.status = 'active');
      v_own_released := v_cash.bank_connection_id IS NULL OR EXISTS (SELECT 1 FROM public.bank_connections b
        WHERE b.id = v_cash.bank_connection_id AND b.company_id = NEW.company_id AND b.status = 'revoked');
      IF NOT v_target_live AND (NOT v_own_released OR EXISTS (
        SELECT 1 FROM public.cash_accounts c JOIN public.bank_connections b ON b.id = c.bank_connection_id AND b.company_id = c.company_id
        WHERE c.company_id = NEW.company_id AND c.id <> v_cash.id AND c.enabled AND b.status = 'active'
          AND c.currency = v_cash.currency
          AND regexp_replace(upper(c.iban), '\s', '', 'g') = regexp_replace(upper(v_cash.iban), '\s', '', 'g')
      )) THEN
        RAISE EXCEPTION 'BANK_BOOKING_REBIND_REFUSED' USING ERRCODE = '23514';
      END IF;
      UPDATE public.transactions SET cash_account_id = v_target_id WHERE company_id = NEW.company_id AND id = v_transaction.id;
      v_transaction.cash_account_id := v_target_id;
    END IF;

    IF v_transaction.cash_account_id IS NOT NULL THEN
      SELECT ledger_account INTO v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id AND currency = v_transaction.currency;
      IF NOT FOUND THEN RAISE EXCEPTION 'BANK_BOOKING_CASH_ACCOUNT_MISSING' USING ERRCODE = '23514'; END IF;
    ELSE
      -- Match resolveSettlementAccount's existing unbound-row fallback.
      SELECT count(*), min(ledger_account) INTO v_count, v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND enabled AND currency = v_transaction.currency;
      IF v_count <> 1 THEN v_ledger := '1930'; END IF;
    END IF;
    IF v_ledger IS DISTINCT FROM v_context->>'settlement_account' OR NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id = NEW.id AND l.account_number = v_ledger
        AND ((v_transaction.amount < 0 AND l.credit_amount > 0) OR (v_transaction.amount > 0 AND l.debit_amount > 0))
    ) THEN
      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = '40001';
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER guard_bank_booking_context BEFORE INSERT OR UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.guard_bank_booking_context();

-- Draft line edits and lawful inline corrections must not change keeper
-- history or the validated settlement lines during a promotion/commit.
-- Existing accounting enforcement triggers remain unchanged and enabled.
CREATE FUNCTION public.lock_cash_history_for_journal_line()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $$
DECLARE v_company_id uuid;
BEGIN
  FOR v_company_id IN SELECT DISTINCT j.company_id FROM public.journal_entries j
    WHERE j.id IN (CASE WHEN TG_OP <> 'INSERT' THEN OLD.journal_entry_id END,
                   CASE WHEN TG_OP <> 'DELETE' THEN NEW.journal_entry_id END)
    ORDER BY j.company_id
  LOOP
    PERFORM public.lock_cash_account_company(v_company_id);
  END LOOP;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER cash_history_journal_line_lock BEFORE INSERT OR UPDATE OR DELETE ON public.journal_entry_lines
  FOR EACH ROW EXECUTE FUNCTION public.lock_cash_history_for_journal_line();

REVOKE ALL ON FUNCTION public.guard_bank_booking_context() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.lock_cash_history_for_journal_line() FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.commit_journal_entry(
  p_company_id uuid,
  p_entry_id uuid,
  p_commit_method text DEFAULT NULL::text,
  p_rubric_version text DEFAULT NULL::text,
  p_actor_type text DEFAULT NULL::text,
  p_actor_label text DEFAULT NULL::text
)
RETURNS TABLE(voucher_number integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $function$
DECLARE
  v_next integer;
  v_fiscal_period_id uuid;
  v_series text;
  v_entry_user_id uuid;
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
BEGIN
  -- Tenant guard: anon/authenticated may only commit entries in their own
  -- companies; service_role / backend (no JWT role) bypasses BY DESIGN.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND p_company_id NOT IN (SELECT public.user_company_ids()) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  PERFORM set_config('gnubok.actor_type', coalesce(p_actor_type, ''), true);
  PERFORM set_config('gnubok.actor_label', coalesce(p_actor_label, ''), true);

  -- Use the same first lock as cash-account promotion, before the draft row.
  PERFORM public.lock_cash_account_company(p_company_id);

  SELECT je.fiscal_period_id, COALESCE(je.voucher_series, 'A'), je.user_id
  INTO v_fiscal_period_id, v_series, v_entry_user_id
  FROM public.journal_entries je
  WHERE je.id = p_entry_id
    AND je.company_id = p_company_id
    AND je.status = 'draft'
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Draft journal entry not found: %', p_entry_id;
  END IF;

  INSERT INTO public.voucher_sequences (company_id, user_id, fiscal_period_id, voucher_series, last_number)
  VALUES (p_company_id, COALESCE(auth.uid(), v_entry_user_id), v_fiscal_period_id, v_series, 1)
  ON CONFLICT (company_id, fiscal_period_id, voucher_series)
  DO UPDATE SET
    last_number = public.voucher_sequences.last_number + 1,
    updated_at = now()
  RETURNING last_number INTO v_next;

  UPDATE public.journal_entries
  SET voucher_number = v_next,
      status = 'posted',
      commit_method = p_commit_method,
      rubric_version = p_rubric_version,
      committed_actor_type = p_actor_type,
      committed_actor_label = p_actor_label
  WHERE id = p_entry_id
    AND company_id = p_company_id;

  RETURN QUERY SELECT v_next;
END;
$function$;

REVOKE ALL ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.commit_journal_entry(uuid, uuid, text, text, text, text) TO authenticated;

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
  PERFORM public.lock_cash_account_company(p_company_id);
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
  IF EXISTS (SELECT 1 FROM unnest(v_retire_ids) AS requested(id) WHERE NOT EXISTS (
    SELECT 1 FROM public.cash_accounts c WHERE c.id = requested.id AND c.company_id = p_company_id))
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

NOTIFY pgrst, 'reload schema';
