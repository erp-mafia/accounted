-- Open Payments as a second bank-feed aggregator beside Enable Banking.
--
-- bank_connections.provider names the BANK (a slug like 'seb-se'), never the
-- service that reaches it, and every function below assumed that service was
-- Enable Banking. aggregator names it. Every existing row is 'enable_banking'
-- through the default and behaves exactly as before; everything new is keyed
-- on 'open_payments'.
--
--   1. bank_connections.aggregator ('enable_banking' | 'open_payments'), fixed
--      for the life of a row; bic, the bank an Open Payments consent is bound
--      to; affiliated_aspsp_id, the sparbank behind SWEDSESS when there is one
--      (every read must name it); consent_attempt, the BankID attempt in
--      flight (method, state, sca status, the Svea listing-only consent, the
--      Enable Banking row a switch replaces). An Open Payments consent id is
--      held by one row only: those consents are bound to one company
--      (PSU-Corporate-ID) and are never shared across companies the way an
--      Enable Banking session is.
--   2. cash_accounts.source may be 'open_payments'; promote_psd2_cash_account
--      takes it from the connection.
--   3. insert_bank_transaction writes import_source from the connection's
--      aggregator (an injected one is ignored, as before); the raw_document_id
--      link of 20261011135800 stays.
--   4. The provider-session guard and the revocation claims derive their
--      namespace from the aggregator: 'enablebanking' exactly as before,
--      'openpayments' for consents. A revocation of one never fences the other.
--   5. supersede_bank_connections only replaces rows of the same aggregator,
--      and attach_shared_bank_session only shares Enable Banking sessions: a
--      superseded or shared row must never hand one service's session id to
--      the other.
--   6. read_bank_configuration and resolve_bank_ingest_route name the
--      connection's aggregator (and bic), so a door that configures, retires
--      or syncs a connection takes the right service without a second read.
--   7. finalize_open_payments_consent: a valid consent turns its pending row
--      into one awaiting account selection, supersedes the company's older
--      Open Payments rows for the same bank, and adopts the Enable Banking
--      dedup scope of the same IBAN + currency so external ids stay stable.
--   8. supersede_enable_banking_connection: at account selection in switch
--      mode, the Enable Banking row hands its transactions and cash-account
--      claims to the Open Payments row and is revoked, across aggregators,
--      carrying the dedup scope.
--
-- Each replaced function is its latest body (20260921202626, 20261011135800,
-- 20261005124500, 20260921201948, 20260921191040, 20260922080840,
-- 20261012100100) with only the lines above changed.
--
-- pg-test: covered-by tests/pg/bank-aggregator.pg.test.ts

ALTER TABLE public.bank_connections
  ADD COLUMN aggregator text NOT NULL DEFAULT 'enable_banking'
    CONSTRAINT bank_connections_aggregator_check CHECK (aggregator IN ('enable_banking', 'open_payments'));

COMMENT ON COLUMN public.bank_connections.aggregator IS
  'The service that reaches the bank: enable_banking or open_payments. provider names the bank. Never changes.';

-- Open Payments addresses a bank by BIC (X-BicFi) and binds the consent to it,
-- so an unattended read must name the same bank. Enable Banking rows leave it
-- empty.
ALTER TABLE public.bank_connections
  ADD COLUMN bic text
    CONSTRAINT bank_connections_bic_check CHECK (
      (bic IS NULL OR bic ~ '^[A-Z0-9]{8}([A-Z0-9]{3})?$')
      AND (aggregator <> 'open_payments' OR bic IS NOT NULL));

COMMENT ON COLUMN public.bank_connections.bic IS
  'BIC of the bank an Open Payments consent is bound to (X-BicFi on every call). Null for Enable Banking.';

ALTER TABLE public.bank_connections
  ADD COLUMN affiliated_aspsp_id text
    CONSTRAINT bank_connections_affiliated_aspsp_id_check CHECK (affiliated_aspsp_id IS NULL OR length(affiliated_aspsp_id) BETWEEN 1 AND 64);

COMMENT ON COLUMN public.bank_connections.affiliated_aspsp_id IS
  'Open Payments X-AffiliatedASPSP-ID: the sparbank behind a shared BIC (SWEDSESS). Null when the bank has none.';

ALTER TABLE public.bank_connections
  ADD COLUMN consent_attempt jsonb
    CONSTRAINT bank_connections_consent_attempt_check CHECK (consent_attempt IS NULL OR jsonb_typeof(consent_attempt) = 'object');

COMMENT ON COLUMN public.bank_connections.consent_attempt IS
  'Open Payments only: the BankID consent attempt in flight {method, state, sca_status, failure_code, started_at, listing_only, replace_connection_id, extended_history_days}. Cleared when the consent is finalized.';

CREATE FUNCTION public.guard_bank_connection_aggregator()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF NEW.aggregator IS DISTINCT FROM OLD.aggregator THEN
    RAISE EXCEPTION 'BANK_CONNECTION_AGGREGATOR_IMMUTABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER bank_connections_aggregator_immutable BEFORE UPDATE OF aggregator ON public.bank_connections
  FOR EACH ROW EXECUTE FUNCTION public.guard_bank_connection_aggregator();

CREATE UNIQUE INDEX bank_connections_open_payments_consent_key
  ON public.bank_connections (session_id)
  WHERE aggregator = 'open_payments' AND session_id IS NOT NULL;

ALTER TABLE public.cash_accounts
  DROP CONSTRAINT cash_accounts_source_check,
  ADD CONSTRAINT cash_accounts_source_check
    CHECK (source IN ('enable_banking', 'open_payments', 'manual', 'sie_import'));

-- The provider-session namespace of an aggregator. 'enablebanking' is the
-- namespace every existing claim and revocation marker already uses.
CREATE FUNCTION public.bank_session_namespace(p_aggregator text)
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $function$
  SELECT CASE p_aggregator WHEN 'open_payments' THEN 'openpayments' ELSE 'enablebanking' END;
$function$;

-- Provider sessions: one namespace per aggregator.
CREATE OR REPLACE FUNCTION public.guard_bank_provider_session_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_session record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.session_id IS NOT DISTINCT FROM OLD.session_id
    AND NEW.status IS NOT DISTINCT FROM OLD.status
    AND NEW.aggregator IS NOT DISTINCT FROM OLD.aggregator THEN RETURN NEW; END IF;
  FOR v_session IN SELECT DISTINCT namespace, session_id FROM (VALUES
    (CASE WHEN TG_OP <> 'INSERT' THEN public.bank_session_namespace(OLD.aggregator) END,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.session_id END),
    (CASE WHEN TG_OP <> 'DELETE' THEN public.bank_session_namespace(NEW.aggregator) END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.session_id END)
  ) candidates(namespace, session_id) WHERE session_id IS NOT NULL ORDER BY namespace, session_id LOOP
    PERFORM public.lock_bank_provider_session(v_session.namespace,v_session.session_id);
  END LOOP;
  IF TG_OP <> 'DELETE' AND NEW.session_id IS NOT NULL AND NEW.status <> 'revoked'
    AND EXISTS(SELECT 1 FROM public.bank_session_revocations
      WHERE provider = public.bank_session_namespace(NEW.aggregator) AND session_id = NEW.session_id) THEN
    RAISE EXCEPTION 'BANK_SESSION_REVOCATION_STARTED' USING ERRCODE = 'PT409';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.claim_bank_session_revocation(p_provider text,p_session_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_row public.bank_session_revocations; v_token uuid := gen_random_uuid();
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('enablebanking','openpayments') THEN
    RAISE EXCEPTION 'BANK_SESSION_PROVIDER_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM public.lock_bank_provider_session(p_provider,p_session_id);
  IF EXISTS(SELECT 1 FROM public.bank_connections WHERE session_id = p_session_id AND status <> 'revoked'
    AND public.bank_session_namespace(aggregator) = p_provider) THEN
    RETURN jsonb_build_object('claimed',false,'reason','shared');
  END IF;
  SELECT * INTO v_row FROM public.bank_session_revocations WHERE provider = p_provider AND session_id = p_session_id FOR UPDATE;
  IF v_row.outcome = 'succeeded' THEN RETURN jsonb_build_object('claimed',false,'reason','already-revoked'); END IF;
  IF v_row.outcome = 'pending' AND v_row.lease_until > clock_timestamp() THEN
    RETURN jsonb_build_object('claimed',false,'reason','in-progress');
  END IF;
  INSERT INTO public.bank_session_revocations(provider,session_id,outcome,claim_token,lease_until,attempts)
  VALUES(p_provider,p_session_id,'pending',v_token,clock_timestamp() + interval '2 minutes',1)
  ON CONFLICT(provider,session_id) DO UPDATE SET outcome = 'pending', claim_token = EXCLUDED.claim_token,
    lease_until = EXCLUDED.lease_until, attempts = bank_session_revocations.attempts + 1, completed_at = NULL;
  RETURN jsonb_build_object('claimed',true,'token',v_token);
END;
$function$;

CREATE OR REPLACE FUNCTION public.finish_bank_session_revocation(p_provider text,p_session_id text,p_claim_token uuid,p_succeeded boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF p_provider IS NULL OR p_provider NOT IN ('enablebanking','openpayments') THEN
    RAISE EXCEPTION 'BANK_SESSION_PROVIDER_INVALID' USING ERRCODE = '22023';
  END IF;
  IF p_succeeded IS NULL THEN RAISE EXCEPTION 'BANK_SESSION_OUTCOME_REQUIRED' USING ERRCODE = '22023'; END IF;
  PERFORM public.lock_bank_provider_session(p_provider,p_session_id);
  UPDATE public.bank_session_revocations SET outcome = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
    completed_at = clock_timestamp(), lease_until = clock_timestamp()
  WHERE provider = p_provider AND session_id = p_session_id AND claim_token = p_claim_token AND outcome = 'pending';
  RETURN FOUND;
END;
$function$;

-- Bank rows carry their aggregator's channel. Body of 20261011135800 plus
-- the import_source read.
CREATE OR REPLACE FUNCTION public.insert_bank_transaction(
  p_company_id uuid,
  p_user_id uuid,
  p_connection_id uuid,
  p_account_uid text,
  p_currency text,
  p_route_token text,
  p_transaction jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  v_route jsonb;
  v_input public.transactions;
  v_transaction public.transactions;
  v_source text;
BEGIN
  v_route := public.resolve_bank_ingest_route(p_company_id, p_connection_id, p_account_uid, p_currency, true);
  IF p_route_token IS DISTINCT FROM v_route->>'token' THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF auth.role() = 'authenticated' AND p_user_id IS DISTINCT FROM auth.uid() THEN
    RAISE EXCEPTION 'BANK_INGEST_ACTOR_MISMATCH' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(p_transaction) IS DISTINCT FROM 'object'
     OR upper(p_transaction->>'currency') IS DISTINCT FROM upper(p_currency) THEN
    RAISE EXCEPTION 'BANK_INGEST_TRANSACTION_INVALID' USING ERRCODE = '22023';
  END IF;
  v_input := jsonb_populate_record(NULL::public.transactions, p_transaction);
  IF v_input.raw_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.document_attachments d
     WHERE d.id = v_input.raw_document_id AND d.company_id = p_company_id
  ) THEN
    RAISE EXCEPTION 'BANK_INGEST_TRANSACTION_INVALID' USING ERRCODE = '22023';
  END IF;
  -- The channel is the connection's aggregator. An injected import_source is
  -- ignored like every other non-source field, so an Enable Banking connection
  -- writes 'enable_banking' exactly as before and nothing can relabel a row.
  SELECT aggregator INTO v_source FROM public.bank_connections
   WHERE company_id = p_company_id AND id = p_connection_id;
  -- Only source fields may enter this boundary. Company, actor and destination
  -- come from checked context; callers cannot inject a journal/invoice anchor.
  INSERT INTO public.transactions(
    company_id, user_id, bank_connection_id, cash_account_id, external_id, date,
    description, original_description, transaction_method, bank_transaction_code,
    proprietary_bank_transaction_code, amount, currency, amount_sek, exchange_rate,
    exchange_rate_date, category, is_business, mcc_code, merchant_name, reference,
    import_source, counterparty_iban, counterparty_account, value_date,
    end_to_end_id, provider_transaction_id, raw_document_id
  ) VALUES (
    p_company_id, p_user_id, p_connection_id, (v_route->>'cashAccountId')::uuid,
    v_input.external_id, v_input.date, v_input.description, v_input.original_description,
    v_input.transaction_method, v_input.bank_transaction_code, v_input.proprietary_bank_transaction_code,
    v_input.amount, upper(p_currency), v_input.amount_sek, v_input.exchange_rate,
    v_input.exchange_rate_date, 'uncategorized', NULL, v_input.mcc_code,
    v_input.merchant_name, v_input.reference, coalesce(v_source, 'enable_banking'),
    v_input.counterparty_iban, v_input.counterparty_account, v_input.value_date,
    v_input.end_to_end_id, v_input.provider_transaction_id, v_input.raw_document_id
  ) RETURNING * INTO v_transaction;
  RETURN to_jsonb(v_transaction);
END;
$$;

-- A bank-fed cash account's source is its connection's aggregator. Body of
-- 20261005124500 plus the source line.
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
$$;

-- Supersession never crosses aggregators. Body of 20260921201948 plus the
-- aggregator predicate.
CREATE OR REPLACE FUNCTION public.supersede_bank_connections(
  p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_expected_token text,
  p_expected_session_id text, p_preserve_scope_uids text[] DEFAULT '{}'
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_survivor public.bank_connections; v_donor public.bank_connections;
  v_ids uuid[]; v_superseded jsonb; v_next jsonb := '[]'; v_account jsonb;
  v_iban text; v_currency text; v_scopes text[]; v_last_synced timestamptz;
  v_moved integer; v_released integer;
BEGIN
  PERFORM public.lock_cash_account_company(p_company_id);
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid())
    OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_user_id
      AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_SUPERSEDE_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_survivor FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF p_expected_token IS DISTINCT FROM public.bank_configuration_token(p_company_id)
    OR p_expected_session_id IS NULL OR v_survivor.session_id IS DISTINCT FROM p_expected_session_id
    OR v_survivor.status NOT IN ('active','pending_selection') OR v_survivor.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_CONFIGURATION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF EXISTS(SELECT 1 FROM unnest(p_preserve_scope_uids) uid WHERE NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(v_survivor.accounts_data) a WHERE a->>'uid' = uid)) THEN
    RAISE EXCEPTION 'BANK_SUPERSEDE_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;

  -- Keep the existing no-IBAN fallback only for non-active rows when neither
  -- side has any IBAN. Otherwise require matching physical account/currency;
  -- separate active logins at the same bank must remain separate.
  SELECT coalesce(array_agg(b.id ORDER BY b.id),'{}'),
    coalesce(jsonb_agg(jsonb_build_object('id',b.id,'session_id',b.session_id) ORDER BY b.id),'[]')
    INTO v_ids,v_superseded
  FROM public.bank_connections b
  WHERE b.company_id = p_company_id AND b.id <> p_connection_id
    AND b.bank_name = v_survivor.bank_name AND b.provider = v_survivor.provider
    AND b.aggregator = v_survivor.aggregator
    AND b.status IN ('active','expired','error','pending_selection') AND b.superseded_by IS NULL
    AND (EXISTS(SELECT 1 FROM jsonb_array_elements(b.accounts_data) old_account,
      jsonb_array_elements(v_survivor.accounts_data) new_account
      WHERE nullif(upper(regexp_replace(old_account->>'iban','\s','','g')),'')
        = nullif(upper(regexp_replace(new_account->>'iban','\s','','g')),'')
      AND upper(coalesce(nullif(old_account->>'currency',''),'SEK')) = upper(coalesce(nullif(new_account->>'currency',''),'SEK')))
    OR (b.status <> 'active'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.accounts_data) a WHERE nullif(regexp_replace(a->>'iban','\s','','g'),'') IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_survivor.accounts_data) a WHERE nullif(regexp_replace(a->>'iban','\s','','g'),'') IS NOT NULL)));
  IF cardinality(v_ids) = 0 THEN
    RETURN jsonb_build_object('superseded','[]'::jsonb,'accounts',coalesce(v_survivor.accounts_data,'[]'),
      'moved_transactions',0,'released_cash_accounts',0);
  END IF;
  PERFORM 1 FROM public.transactions WHERE company_id = p_company_id AND bank_connection_id = ANY(v_ids) ORDER BY id FOR UPDATE;

  -- Carry only explicit legacy scopes, as before. A survivor's existing
  -- explicit scope wins. Currency is part of identity so scopes cannot leak
  -- between resources which happen to share an IBAN. Conflicting donors
  -- require review; arbitrary row order must not determine future IDs.
  FOR v_account IN SELECT value FROM jsonb_array_elements(v_survivor.accounts_data) LOOP
    v_iban := nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'');
    v_currency := upper(coalesce(nullif(v_account->>'currency',''),'SEK'));
    IF v_iban IS NOT NULL AND NOT (v_account->>'uid' = ANY(coalesce(p_preserve_scope_uids,'{}')))
      AND (nullif(v_account->>'dedup_scope','') IS NULL OR v_account->>'dedup_scope' IN (v_iban,v_account->>'uid')) THEN
      SELECT array_agg(DISTINCT a->>'dedup_scope' ORDER BY a->>'dedup_scope') INTO v_scopes
      FROM public.bank_connections b CROSS JOIN LATERAL jsonb_array_elements(b.accounts_data) a
      WHERE b.company_id = p_company_id AND b.id = ANY(v_ids)
        AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban
        AND upper(coalesce(nullif(a->>'currency',''),'SEK')) = v_currency AND nullif(a->>'dedup_scope','') IS NOT NULL;
      IF cardinality(v_scopes) > 1 THEN
        RAISE EXCEPTION 'BANK_SUPERSEDE_SCOPE_AMBIGUOUS' USING ERRCODE = 'PT409';
      END IF;
      IF cardinality(v_scopes) = 1 THEN
        v_account := v_account || jsonb_build_object('dedup_scope',v_scopes[1]);
      END IF;
    END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;

  SELECT max(last_synced_at) INTO v_last_synced FROM public.bank_connections WHERE company_id = p_company_id AND id = ANY(v_ids);
  SELECT * INTO v_donor FROM public.bank_connections WHERE company_id = p_company_id AND id = ANY(v_ids)
    AND initial_sync_completed_at IS NOT NULL ORDER BY initial_sync_completed_at DESC,id LIMIT 1;

  UPDATE public.transactions SET bank_connection_id = p_connection_id
    WHERE company_id = p_company_id AND bank_connection_id = ANY(v_ids);
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  UPDATE public.cash_accounts SET bank_connection_id = NULL, external_uid = NULL
    WHERE company_id = p_company_id AND bank_connection_id = ANY(v_ids);
  GET DIAGNOSTICS v_released = ROW_COUNT;
  UPDATE public.bank_connections SET status = 'revoked', session_id = NULL, oauth_state = NULL,
    oauth_origin = NULL, authorization_id = NULL, error_message = NULL,
    superseded_by = p_connection_id, superseded_at = clock_timestamp()
    WHERE company_id = p_company_id AND id = ANY(v_ids);
  UPDATE public.bank_connections SET accounts_data = v_next,
    last_synced_at = coalesce(last_synced_at,v_last_synced),
    initial_sync_requested_from = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_requested_from ELSE initial_sync_requested_from END,
    initial_sync_returned_min_date = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_returned_min_date ELSE initial_sync_returned_min_date END,
    initial_sync_returned_max_date = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_returned_max_date ELSE initial_sync_returned_max_date END,
    initial_sync_lookback_days = CASE WHEN initial_sync_completed_at IS NULL AND v_donor.id IS NOT NULL THEN v_donor.initial_sync_lookback_days ELSE initial_sync_lookback_days END,
    initial_sync_completed_at = coalesce(initial_sync_completed_at,v_donor.initial_sync_completed_at)
    WHERE company_id = p_company_id AND id = p_connection_id;

  RETURN jsonb_build_object('superseded',v_superseded,'accounts',v_next,
    'moved_transactions',v_moved,'released_cash_accounts',v_released);
END;
$function$;

-- A configuration snapshot says which aggregator owns the connection, and
-- which bank the consent is bound to. Body of 20260921191040 plus those keys.
CREATE OR REPLACE FUNCTION public.read_bank_configuration(p_company_id uuid, p_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_connection public.bank_connections;
BEGIN
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  RETURN jsonb_build_object('token', public.bank_configuration_token(p_company_id), 'connection',
    jsonb_build_object('id', v_connection.id, 'status', v_connection.status, 'accounts_data', v_connection.accounts_data,
      'session_id', v_connection.session_id, 'bank_name', v_connection.bank_name,
      'aggregator', v_connection.aggregator, 'bic', v_connection.bic));
END;
$function$;

-- Only Enable Banking sessions are shared between companies. Body of
-- 20260922080840 plus the aggregator predicate.
CREATE OR REPLACE FUNCTION public.attach_shared_bank_session(p_company_id uuid, p_user_id uuid, p_source_connection_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_companies uuid[]; v_current_companies uuid[]; v_company uuid;
  v_source public.bank_connections; v_account jsonb; v_accounts jsonb := '[]';
  v_iban text; v_seen text[] := '{}'; v_id uuid;
BEGIN
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id) THEN
    RAISE EXCEPTION 'BANK_ATTACH_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  SELECT coalesce(array_agg(cm.company_id ORDER BY cm.company_id),'{}') INTO v_companies
    FROM public.company_members cm JOIN public.companies c ON c.id = cm.company_id
    WHERE cm.user_id = p_user_id AND c.archived_at IS NULL;
  IF NOT (p_company_id = ANY(v_companies)) OR NOT EXISTS(SELECT 1 FROM public.company_members
    WHERE company_id = p_company_id AND user_id = p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_ATTACH_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  FOREACH v_company IN ARRAY v_companies LOOP
    PERFORM public.lock_cash_account_company(v_company);
  END LOOP;
  -- A membership/archival change during acquisition requires a fresh request.
  SELECT coalesce(array_agg(cm.company_id ORDER BY cm.company_id),'{}') INTO v_current_companies
    FROM public.company_members cm JOIN public.companies c ON c.id = cm.company_id
    WHERE cm.user_id = p_user_id AND c.archived_at IS NULL;
  IF v_companies IS DISTINCT FROM v_current_companies THEN
    RAISE EXCEPTION 'BANK_ATTACH_MEMBERSHIP_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id = p_company_id
    AND user_id = p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_ATTACH_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = ANY(v_companies) ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = ANY(v_companies) ORDER BY id FOR UPDATE;
  SELECT * INTO v_source FROM public.bank_connections WHERE id = p_source_connection_id
    AND company_id = ANY(v_companies) AND company_id <> p_company_id AND user_id = p_user_id
    AND status = 'active' AND session_id IS NOT NULL AND consent_expires > clock_timestamp()
    AND superseded_by IS NULL AND aggregator = 'enable_banking';
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_REUSABLE_SESSION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF EXISTS(SELECT 1 FROM public.bank_connections WHERE company_id = p_company_id AND provider = v_source.provider
    AND status IN ('active','pending_selection')) THEN
    RAISE EXCEPTION 'BANK_ATTACH_ALREADY_CONNECTED' USING ERRCODE = 'PT409';
  END IF;
  IF jsonb_typeof(coalesce(v_source.accounts_data,'[]')) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'BANK_ATTACH_SOURCE_INVALID' USING ERRCODE = 'PT409';
  END IF;
  FOR v_account IN SELECT value FROM jsonb_array_elements(coalesce(v_source.accounts_data,'[]')) LOOP
    v_iban := nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'');
    -- Preserve the existing conservative offer rule: no no-IBAN accounts,
    -- and at most one resource per IBAN even for multi-currency resources.
    IF v_iban IS NULL OR v_iban = ANY(v_seen) THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.cash_accounts c WHERE c.company_id = ANY(v_companies) AND c.enabled
      AND nullif(upper(regexp_replace(c.iban,'\s','','g')),'') = v_iban)
      OR EXISTS(SELECT 1 FROM public.bank_connections b, LATERAL jsonb_array_elements(coalesce(b.accounts_data,'[]')) a
        WHERE b.company_id = ANY(v_companies) AND b.company_id <> v_source.company_id AND b.user_id = p_user_id
          AND b.status IN ('active','pending_selection') AND coalesce((a->>'enabled')::boolean,true)
          AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban) THEN CONTINUE; END IF;
    IF jsonb_typeof(v_account) <> 'object' OR nullif(v_account->>'uid','') IS NULL
      OR coalesce(v_account->>'currency','') !~ '^[A-Z]{3}$'
      OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_accounts) a WHERE a->>'uid' = v_account->>'uid') THEN
      RAISE EXCEPTION 'BANK_ATTACH_SOURCE_INVALID' USING ERRCODE = 'PT409';
    END IF;
    v_seen := array_append(v_seen,v_iban);
    v_accounts := v_accounts || jsonb_build_array((v_account - ARRAY['ledger_account','claimed_by_company_id',
      'claimed_by_company_name','deselected_elsewhere']) || jsonb_build_object('enabled',true));
  END LOOP;
  IF jsonb_array_length(v_accounts) = 0 THEN
    RAISE EXCEPTION 'BANK_REUSABLE_SESSION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  -- The existing provider-session guard checks the canonical Enable Banking
  -- revocation marker and serializes this new holder against provider DELETE.
  INSERT INTO public.bank_connections(company_id,user_id,provider,bank_name,session_id,psu_type,consent_expires,accounts_data,status)
    VALUES(p_company_id,p_user_id,v_source.provider,v_source.bank_name,v_source.session_id,v_source.psu_type,
      v_source.consent_expires,v_accounts,'pending_selection') RETURNING id INTO v_id;
  RETURN jsonb_build_object('connection_id',v_id,'account_count',jsonb_array_length(v_accounts),
    'bank_name',v_source.bank_name,'consent_expires',v_source.consent_expires);
END;
$function$;

-- The ingest route names the aggregator and the bank, so the sync branches
-- on the row it just verified instead of reading the connection twice. Body
-- of 20261012100100 plus the two keys; the token is unchanged.
CREATE OR REPLACE FUNCTION public.resolve_bank_ingest_route(p_company_id uuid, p_connection_id uuid, p_account_uid text, p_currency text, p_lock boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_connection public.bank_connections;
  v_cash public.cash_accounts;
  v_account jsonb;
  v_token text;
BEGIN
  IF p_lock THEN
    SELECT * INTO v_connection FROM public.bank_connections
     WHERE company_id = p_company_id AND id = p_connection_id FOR SHARE;
  ELSE
    SELECT * INTO v_connection FROM public.bank_connections
     WHERE company_id = p_company_id AND id = p_connection_id;
  END IF;
  IF v_connection.id IS NULL OR v_connection.status IS NULL
     OR v_connection.status NOT IN ('active', 'error') OR v_connection.superseded_by IS NOT NULL
     OR nullif(v_connection.session_id, '') IS NULL THEN
    RAISE EXCEPTION 'BANK_INGEST_CONNECTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF (SELECT count(*) FROM jsonb_array_elements(coalesce(v_connection.accounts_data, '[]'::jsonb)) a
       WHERE a->>'uid' = p_account_uid) <> 1 THEN
    RAISE EXCEPTION 'BANK_INGEST_ACCOUNT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  SELECT value INTO v_account FROM jsonb_array_elements(v_connection.accounts_data)
   WHERE value->>'uid' = p_account_uid;
  IF coalesce((v_account->>'enabled')::boolean, true) IS NOT TRUE
     OR upper(v_account->>'currency') IS DISTINCT FROM upper(p_currency) THEN
    RAISE EXCEPTION 'BANK_INGEST_ACCOUNT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF p_lock THEN
    SELECT * INTO v_cash FROM public.cash_accounts
     WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
       AND external_uid = p_account_uid FOR SHARE;
  ELSE
    SELECT * INTO v_cash FROM public.cash_accounts
     WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
       AND external_uid = p_account_uid;
  END IF;
  IF v_cash.id IS NULL OR v_cash.enabled IS NOT TRUE
     OR upper(v_cash.currency) IS DISTINCT FROM upper(p_currency)
     OR v_account->>'ledger_account' IS DISTINCT FROM v_cash.ledger_account THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_UNRESOLVED' USING ERRCODE = 'PT409';
  END IF;
  -- A matching ledger is insufficient when the account identity itself drifted.
  IF nullif(regexp_replace(v_account->>'iban', '\s', '', 'g'), '') IS NOT NULL
     AND upper(regexp_replace(v_account->>'iban', '\s', '', 'g'))
       IS DISTINCT FROM upper(regexp_replace(v_cash.iban, '\s', '', 'g')) THEN
    RAISE EXCEPTION 'BANK_INGEST_IDENTITY_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  v_token := md5(jsonb_build_array('bank-route-v1', p_company_id, v_connection.id,
    v_connection.session_id, p_account_uid, v_cash.id, v_cash.ledger_account,
    upper(v_cash.currency), upper(regexp_replace(v_cash.iban, '\s', '', 'g')),
    v_cash.bban, v_cash.enabled, v_account->>'enabled')::text);
  RETURN jsonb_build_object('connectionId', v_connection.id, 'sessionId', v_connection.session_id,
    'accountUid', p_account_uid, 'cashAccountId', v_cash.id, 'ledgerAccount', v_cash.ledger_account,
    'currency', upper(v_cash.currency), 'token', v_token,
    'aggregator', v_connection.aggregator, 'bic', v_connection.bic);
END;
$function$;

-- A consent the bank reports valid: the pending attempt becomes a connection
-- awaiting account selection, and older Open Payments rows for the same bank
-- and accounts are superseded (the bank already expired their consent when
-- this one was authorised). An account the company fetched before through
-- Enable Banking keeps that feed's dedup scope, so its transactions get the
-- same external ids and are not imported twice. The attempt record is cleared;
-- what the selection step still needs of it (the row a switch replaces, the
-- bank's extended history window) is kept under consent_attempt.selection.
CREATE FUNCTION public.finalize_open_payments_consent(
  p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_consent_id text,
  p_consent_expires timestamptz, p_accounts jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_connection public.bank_connections; v_account jsonb; v_next jsonb := '[]';
  v_iban text; v_scopes text[]; v_preserve text[] := '{}'; v_supersede jsonb; v_kept jsonb;
BEGIN
  IF nullif(p_consent_id,'') IS NULL OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) a WHERE jsonb_typeof(a) <> 'object'
      OR nullif(a->>'uid','') IS NULL OR coalesce(a->>'currency','') !~ '^[A-Z]{3}$'
      OR jsonb_typeof(a->'enabled') IS DISTINCT FROM 'boolean')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) a GROUP BY a->>'uid' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'BANK_CONSENT_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM public.lock_cash_account_company(p_company_id);
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id)
    OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id = p_company_id
      AND user_id = p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_CONSENT_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND OR v_connection.aggregator <> 'open_payments' THEN
    RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002';
  END IF;
  IF v_connection.session_id IS DISTINCT FROM p_consent_id OR v_connection.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_CONSENT_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  -- A second poll that also saw the consent valid finds the work done.
  IF v_connection.status IN ('pending_selection','active') THEN
    RETURN jsonb_build_object('connection_id',v_connection.id,'accounts',coalesce(v_connection.accounts_data,'[]'),
      'superseded','[]'::jsonb,'already_finalized',true);
  END IF;
  IF v_connection.status <> 'pending' THEN
    RAISE EXCEPTION 'BANK_CONSENT_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  FOR v_account IN SELECT value FROM jsonb_array_elements(p_accounts) LOOP
    -- Selection and scope are owned here and by the account picker, never the caller.
    v_account := v_account - ARRAY['ledger_account','dedup_scope','claimed_by_company_id',
      'claimed_by_company_name','deselected_elsewhere'];
    v_iban := nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'');
    IF v_iban IS NOT NULL THEN
      SELECT array_agg(DISTINCT a->>'dedup_scope' ORDER BY a->>'dedup_scope') INTO v_scopes
      FROM public.bank_connections b CROSS JOIN LATERAL jsonb_array_elements(coalesce(b.accounts_data,'[]')) a
      WHERE b.company_id = p_company_id AND b.id <> p_connection_id AND b.aggregator <> 'open_payments'
        AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban
        AND upper(coalesce(nullif(a->>'currency',''),'SEK')) = upper(v_account->>'currency')
        AND nullif(a->>'dedup_scope','') IS NOT NULL;
      IF cardinality(v_scopes) = 1 THEN
        v_account := v_account || jsonb_build_object('dedup_scope',v_scopes[1]);
        v_preserve := array_append(v_preserve,v_account->>'uid');
      END IF;
    END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;

  -- The selection step still needs three facts of the attempt: the Enable
  -- Banking row a switch replaces, the bank's extended history window, and
  -- whether this consent only lists accounts (Svea: a second consent naming
  -- the chosen accounts follows before anything can be read).
  v_kept := jsonb_strip_nulls(jsonb_build_object(
    'replace_connection_id', v_connection.consent_attempt->'replace_connection_id',
    'extended_history_days', v_connection.consent_attempt->'extended_history_days',
    'listing_only', v_connection.consent_attempt->'listing_only'));
  UPDATE public.bank_connections SET status = 'pending_selection', accounts_data = v_next,
    consent_expires = p_consent_expires, authorization_id = NULL, error_message = NULL,
    consent_attempt = CASE WHEN v_kept = '{}'::jsonb THEN NULL ELSE jsonb_build_object('selection', v_kept) END
    WHERE company_id = p_company_id AND id = p_connection_id;
  v_supersede := public.supersede_bank_connections(p_company_id,p_user_id,p_connection_id,
    public.bank_configuration_token(p_company_id),p_consent_id,v_preserve);
  RETURN jsonb_build_object('connection_id',p_connection_id,'accounts',v_supersede->'accounts',
    'superseded',v_supersede->'superseded','already_finalized',false);
END;
$function$;

-- Switching a bank from Enable Banking to Open Payments: at account selection
-- the Enable Banking row hands over its transactions (bank_connection_id) and
-- releases its cash-account claims, exactly as supersede_bank_connections does
-- for siblings of one aggregator, and is revoked with superseded_by pointing
-- at the Open Payments row. The dedup scope of the same IBAN + currency is
-- carried so the first Open Payments import mints the same external ids and
-- nothing is imported twice. Nothing else is carried: the Open Payments row
-- runs its own first import (the extended history window) and keeps its own
-- sync cursor.
CREATE FUNCTION public.supersede_enable_banking_connection(
  p_company_id uuid, p_user_id uuid, p_new uuid, p_old uuid
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE
  v_new public.bank_connections; v_old public.bank_connections;
  v_account jsonb; v_next jsonb := '[]'; v_iban text; v_currency text; v_scopes text[];
  v_moved integer; v_released integer;
BEGIN
  PERFORM public.lock_cash_account_company(p_company_id);
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND p_user_id IS DISTINCT FROM auth.uid())
    OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_user_id
      AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_SUPERSEDE_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_new FROM public.bank_connections WHERE company_id = p_company_id AND id = p_new;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT * INTO v_old FROM public.bank_connections WHERE company_id = p_company_id AND id = p_old;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF p_new = p_old OR v_new.aggregator <> 'open_payments' OR v_new.status NOT IN ('active','pending_selection')
    OR v_new.superseded_by IS NOT NULL OR v_new.session_id IS NULL
    OR v_old.aggregator <> 'enable_banking' OR v_old.status = 'revoked' OR v_old.superseded_by IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_CONFIGURATION_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  -- The Enable Banking scope of the same physical account wins over the IBAN
  -- or uid default; an explicit custom scope on the new row is kept.
  FOR v_account IN SELECT value FROM jsonb_array_elements(coalesce(v_new.accounts_data,'[]')) LOOP
    v_iban := nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'');
    v_currency := upper(coalesce(nullif(v_account->>'currency',''),'SEK'));
    IF v_iban IS NOT NULL
      AND (nullif(v_account->>'dedup_scope','') IS NULL OR v_account->>'dedup_scope' IN (v_iban,v_account->>'uid')) THEN
      SELECT array_agg(DISTINCT a->>'dedup_scope' ORDER BY a->>'dedup_scope') INTO v_scopes
      FROM jsonb_array_elements(coalesce(v_old.accounts_data,'[]')) a
      WHERE nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban
        AND upper(coalesce(nullif(a->>'currency',''),'SEK')) = v_currency AND nullif(a->>'dedup_scope','') IS NOT NULL;
      IF cardinality(v_scopes) > 1 THEN
        RAISE EXCEPTION 'BANK_SUPERSEDE_SCOPE_AMBIGUOUS' USING ERRCODE = 'PT409';
      END IF;
      IF cardinality(v_scopes) = 1 THEN
        v_account := v_account || jsonb_build_object('dedup_scope',v_scopes[1]);
      END IF;
    END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;

  PERFORM 1 FROM public.transactions WHERE company_id = p_company_id AND bank_connection_id = p_old ORDER BY id FOR UPDATE;
  UPDATE public.transactions SET bank_connection_id = p_new
    WHERE company_id = p_company_id AND bank_connection_id = p_old;
  GET DIAGNOSTICS v_moved = ROW_COUNT;
  UPDATE public.cash_accounts SET bank_connection_id = NULL, external_uid = NULL
    WHERE company_id = p_company_id AND bank_connection_id = p_old;
  GET DIAGNOSTICS v_released = ROW_COUNT;
  UPDATE public.bank_connections SET status = 'revoked', session_id = NULL, oauth_state = NULL,
    oauth_origin = NULL, authorization_id = NULL, error_message = NULL,
    superseded_by = p_new, superseded_at = clock_timestamp()
    WHERE company_id = p_company_id AND id = p_old;
  UPDATE public.bank_connections SET accounts_data = v_next
    WHERE company_id = p_company_id AND id = p_new;

  RETURN jsonb_build_object('superseded', jsonb_build_array(jsonb_build_object('id', v_old.id, 'session_id', v_old.session_id)),
    'accounts', v_next, 'moved_transactions', v_moved, 'released_cash_accounts', v_released);
END;
$function$;

REVOKE ALL ON FUNCTION public.guard_bank_connection_aggregator() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.bank_session_namespace(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.bank_session_namespace(text) TO service_role;
REVOKE ALL ON FUNCTION public.finalize_open_payments_consent(uuid,uuid,uuid,text,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.finalize_open_payments_consent(uuid,uuid,uuid,text,timestamptz,jsonb) TO service_role;
REVOKE ALL ON FUNCTION public.supersede_enable_banking_connection(uuid,uuid,uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supersede_enable_banking_connection(uuid,uuid,uuid,uuid) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
