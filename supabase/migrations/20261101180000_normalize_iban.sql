-- One normalization of an IBAN in SQL: public.normalize_iban.
--
-- Eighteen functions spelled it by hand, in five shapes, 63 times: with or
-- without nullif, upper outside or inside regexp_replace. Two rows of one bank
-- account are the same account by this expression (lib/cash-accounts/service.ts
-- physicalAccountKey is the TypeScript side), so a function that spells it
-- differently is a function with its own idea of which account a row is.
--
-- The bodies below are today's definitions from a replay of every migration
-- (pg_get_functiondef, so nothing older than origin/main is restated), with the
-- expression swapped for the call and nothing else. An IBAN that is blank after
-- the spaces go reads NULL everywhere now. Five sites had no nullif, so a blank
-- read '' there: each sits behind a test that the IBAN is present, or compares
-- with IS DISTINCT FROM against one that is, and no stored IBAN is blank.
-- resolve_bank_ingest_route hashes the value into a short-lived route token,
-- where a NULL IBAN stays NULL. Nothing here rewrites a row.
--
-- pg-test: tests/pg/normalize-iban.pg.test.ts

CREATE OR REPLACE FUNCTION public.normalize_iban(p_iban text)
RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path TO ''
AS $function$
  SELECT nullif(upper(regexp_replace(p_iban, '\s', '', 'g')), '')
$function$;

REVOKE ALL ON FUNCTION public.normalize_iban(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.normalize_iban(text) TO authenticated, service_role;

COMMENT ON FUNCTION public.normalize_iban(text) IS
  'An IBAN for comparison: no whitespace, upper case, NULL when nothing is left. The one normalization in SQL; lib/cash-accounts/ledger-slots.ts normalizeIban is the TypeScript side.';

CREATE OR REPLACE FUNCTION public.attach_shared_bank_session(p_company_id uuid, p_user_id uuid, p_source_connection_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
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
    v_iban := public.normalize_iban(v_account->>'iban');
    -- Preserve the existing conservative offer rule: no no-IBAN accounts,
    -- and at most one resource per IBAN even for multi-currency resources.
    IF v_iban IS NULL OR v_iban = ANY(v_seen) THEN CONTINUE; END IF;
    IF EXISTS(SELECT 1 FROM public.cash_accounts c WHERE c.company_id = ANY(v_companies) AND c.enabled
      AND public.normalize_iban(c.iban) = v_iban)
      OR EXISTS(SELECT 1 FROM public.bank_connections b, LATERAL jsonb_array_elements(coalesce(b.accounts_data,'[]')) a
        WHERE b.company_id = ANY(v_companies) AND b.company_id <> v_source.company_id AND b.user_id = p_user_id
          AND b.status IN ('active','pending_selection') AND coalesce((a->>'enabled')::boolean,true)
          AND public.normalize_iban(a->>'iban') = v_iban) THEN CONTINUE; END IF;
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

CREATE OR REPLACE FUNCTION public.bind_bank_transaction(p_company_id uuid, p_connection_id uuid, p_account_uid text, p_currency text, p_route_token text, p_transaction_id uuid, p_expected_date date, p_expected_amount numeric)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_route jsonb;
  v_transaction public.transactions;
  v_destination public.cash_accounts;
  v_existing public.cash_accounts;
  v_entry_id uuid;
BEGIN
  v_route := public.resolve_bank_ingest_route(p_company_id, p_connection_id, p_account_uid, p_currency, true);
  IF p_route_token IS DISTINCT FROM v_route->>'token' THEN
    RAISE EXCEPTION 'BANK_INGEST_ROUTE_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  SELECT * INTO v_destination FROM public.cash_accounts WHERE id = (v_route->>'cashAccountId')::uuid AND company_id = p_company_id;
  SELECT * INTO v_transaction FROM public.transactions WHERE id = p_transaction_id AND company_id = p_company_id FOR UPDATE;
  IF v_transaction.id IS NULL OR upper(v_transaction.currency) IS DISTINCT FROM upper(p_currency)
     OR v_transaction.date IS DISTINCT FROM p_expected_date OR v_transaction.amount IS DISTINCT FROM p_expected_amount THEN
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  IF v_transaction.cash_account_id IS NOT NULL THEN
    IF v_transaction.cash_account_id = v_destination.id THEN RETURN v_destination.id; END IF;
    SELECT * INTO v_existing FROM public.cash_accounts WHERE id = v_transaction.cash_account_id AND company_id = p_company_id;
    -- Another writer may have bound the row to a retained twin. The same
    -- physical account is still a valid dedup match; never overwrite its anchor.
    IF public.normalize_iban(v_existing.iban) IS NOT NULL
       AND public.normalize_iban(v_existing.iban) = public.normalize_iban(v_destination.iban)
       AND upper(v_existing.currency) = upper(v_destination.currency) THEN
      RETURN v_existing.id;
    END IF;
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  -- The candidate was a manual row. If it became a feed row while this batch
  -- was deduplicating, the caller must reconsider the match on a fresh read.
  IF v_transaction.bank_connection_id IS NOT NULL THEN
    RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  -- Revalidate accounting anchors AFTER locking the transaction. An earlier
  -- application-side read cannot prove which ledger an anchor now explains.
  FOR v_entry_id IN
    SELECT v_transaction.journal_entry_id WHERE v_transaction.journal_entry_id IS NOT NULL
    UNION SELECT journal_entry_id FROM public.transaction_voucher_links
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id AND role = 'bank_line'
    UNION SELECT journal_entry_id FROM public.invoice_payments
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id
    UNION SELECT journal_entry_id FROM public.supplier_invoice_payments
      WHERE transaction_id = p_transaction_id AND company_id = p_company_id
  LOOP
    IF v_entry_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM public.journal_entries j JOIN public.journal_entry_lines l ON l.journal_entry_id = j.id
       WHERE j.company_id = p_company_id AND j.id = v_entry_id AND l.account_number = v_destination.ledger_account
    ) THEN
      RAISE EXCEPTION 'BANK_INGEST_ADOPTION_ANCHOR_CHANGED' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;
  UPDATE public.transactions SET cash_account_id = v_destination.id
   WHERE id = p_transaction_id AND company_id = p_company_id AND cash_account_id IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_INGEST_ADOPTION_CHANGED' USING ERRCODE = 'PT409'; END IF;
  RETURN v_destination.id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cash_account_payee_json(p_cash_account_id uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'bank_name',              NULLIF(btrim(ca.bank_name), ''),
    'clearing_number',        NULLIF(btrim(ca.clearing_number), ''),
    'account_number',         NULLIF(btrim(ca.account_number), ''),
    'bankgiro',               NULLIF(btrim(ca.bankgiro), ''),
    'plusgiro',               NULLIF(btrim(ca.plusgiro), ''),
    'swish',                  NULLIF(btrim(ca.swish), ''),
    'iban',                   public.normalize_iban(ca.payee_iban),
    'bic',                    NULLIF(upper(regexp_replace(ca.bic, '\s', '', 'g')), ''),
    'bank_code',              NULLIF(regexp_replace(ca.bank_code, '\s', '', 'g'), ''),
    'foreign_account_number', NULLIF(regexp_replace(ca.foreign_account_number, '\s', '', 'g'), '')
  ))
  FROM public.cash_accounts ca
  WHERE ca.id = p_cash_account_id;
$function$;

CREATE OR REPLACE FUNCTION public.cash_account_refusal_detail(p_company_id uuid, p_cash_account_id uuid, p_ledger_account text, p_dependencies text[] DEFAULT NULL::text[])
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO ''
AS $function$
  SELECT jsonb_strip_nulls(jsonb_build_object(
    'ledger_account', p_ledger_account,
    'dependencies', to_jsonb(p_dependencies),
    'cash_account', (
      SELECT jsonb_build_object(
        'id', c.id,
        'ledger_account', c.ledger_account,
        'name', nullif(btrim(c.name), ''),
        'iban_last4', right(public.normalize_iban(c.iban), 4),
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

CREATE OR REPLACE FUNCTION public.cash_accounts_payee_iban_follows_identity()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_old_identity text := public.normalize_iban(OLD.iban);
  v_new_identity text := public.normalize_iban(NEW.iban);
BEGIN
  IF v_old_identity IS NULL
    OR v_new_identity IS NULL
    OR v_new_identity = v_old_identity
    OR NEW.payee_iban IS DISTINCT FROM OLD.payee_iban
    OR public.normalize_iban(OLD.payee_iban) IS DISTINCT FROM v_old_identity
  THEN
    RETURN NEW;
  END IF;
  -- The same writers cash_accounts_payee_admin_only lets change a payee
  -- column; a member's identity write leaves the printed IBAN alone.
  IF auth.uid() IS NOT NULL AND NOT public.user_is_company_admin(NEW.company_id) THEN
    RETURN NEW;
  END IF;
  NEW.payee_iban := v_new_identity;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_bank_callback(p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_oauth_state text, p_expected_token text, p_session_id text, p_consent_expires timestamp with time zone, p_accounts jsonb, p_mirrors jsonb, p_chart_accounts jsonb, p_no_iban_pairs jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_connection public.bank_connections; v_chart public.chart_of_accounts;
  v_account jsonb; v_prior jsonb; v_mirror jsonb; v_next jsonb := '[]'; v_supersede jsonb;
  v_iban text; v_currency text; v_count integer; v_preserve text[] := '{}';
  v_observations text[] := ARRAY['balance','available_balance','balance_updated_at','accepted_history_days'];
BEGIN
  IF nullif(p_oauth_state,'') IS NULL OR nullif(p_session_id,'') IS NULL
    OR jsonb_typeof(p_accounts) IS DISTINCT FROM 'array' OR jsonb_typeof(p_mirrors) IS DISTINCT FROM 'array'
    OR jsonb_typeof(p_chart_accounts) IS DISTINCT FROM 'array' OR jsonb_typeof(p_no_iban_pairs) IS DISTINCT FROM 'object'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) a WHERE jsonb_typeof(a) <> 'object'
      OR nullif(a->>'uid','') IS NULL OR coalesce(a->>'currency','') !~ '^[A-Z]{3}$'
      OR jsonb_typeof(a->'enabled') IS DISTINCT FROM 'boolean')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) a GROUP BY a->>'uid' HAVING count(*) > 1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m WHERE jsonb_typeof(m) <> 'object'
      OR coalesce(m->>'ledger_account','') !~ '^19[0-9]{2}$'
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) a WHERE a->>'uid' = m->>'uid'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m GROUP BY m->>'uid' HAVING count(*) > 1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m GROUP BY m->>'ledger_account' HAVING count(*) > 1)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) a WHERE (a->>'enabled')::boolean
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m WHERE m->>'uid' = a->>'uid')) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM public.lock_cash_account_company(p_company_id);
  IF p_user_id IS NULL OR (auth.uid() IS NOT NULL AND auth.uid() IS DISTINCT FROM p_user_id) OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id = p_company_id
    AND user_id = p_user_id AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_ACTOR_DENIED' USING ERRCODE = '42501';
  END IF;
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'BANK_CONNECTION_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  IF v_connection.user_id IS DISTINCT FROM p_user_id OR v_connection.oauth_state IS DISTINCT FROM p_oauth_state
    OR v_connection.status NOT IN ('pending','expired','error') OR v_connection.superseded_by IS NOT NULL
    OR p_expected_token IS DISTINCT FROM public.bank_configuration_token(p_company_id) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  IF jsonb_typeof(coalesce(v_connection.accounts_data,'[]')) IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
      WHERE jsonb_typeof(a) <> 'object' OR nullif(a->>'uid','') IS NULL OR coalesce(upper(a->>'currency'),'') !~ '^[A-Z]{3}$')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a GROUP BY a->>'uid' HAVING count(*) > 1)
    OR EXISTS(SELECT 1 FROM jsonb_each_text(p_no_iban_pairs) p WHERE NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(p_accounts) a WHERE a->>'uid' = p.key)) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_PRIOR_INVALID' USING ERRCODE = 'PT409';
  END IF;

  -- The token excludes sync observations. Carry those from the CURRENT prior
  -- account using UID plus identity, then unique IBAN/currency, or the existing
  -- unambiguous no-IBAN pairing. Never copy observations across a reused UID
  -- that now names another physical account.
  FOR v_account IN SELECT value FROM jsonb_array_elements(p_accounts) LOOP
    v_iban := public.normalize_iban(v_account->>'iban');
    v_currency := v_account->>'currency'; v_prior := NULL;
    SELECT a INTO v_prior FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
      WHERE a->>'uid' = v_account->>'uid' AND upper(a->>'currency') = v_currency
      AND (v_iban IS NULL OR public.normalize_iban(a->>'iban') IS NULL
        OR public.normalize_iban(a->>'iban') = v_iban);
    IF v_prior IS NULL AND v_iban IS NOT NULL THEN
      SELECT count(*) INTO v_count FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
        WHERE upper(a->>'currency') = v_currency AND public.normalize_iban(a->>'iban') = v_iban;
      IF v_count > 1 THEN RAISE EXCEPTION 'BANK_CALLBACK_IDENTITY_AMBIGUOUS' USING ERRCODE = 'PT409'; END IF;
      SELECT a INTO v_prior FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
        WHERE upper(a->>'currency') = v_currency AND public.normalize_iban(a->>'iban') = v_iban;
    END IF;
    IF v_prior IS NULL AND p_no_iban_pairs ? (v_account->>'uid') THEN
      SELECT a INTO v_prior FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
        WHERE a->>'uid' = p_no_iban_pairs->>(v_account->>'uid');
      IF v_iban IS NOT NULL OR v_prior IS NULL OR upper(v_prior->>'currency') IS DISTINCT FROM v_currency
        OR public.normalize_iban(v_prior->>'iban') IS NOT NULL
        OR (SELECT count(*) FROM jsonb_each_text(p_no_iban_pairs) p WHERE p.value = v_prior->>'uid') <> 1
        OR (SELECT count(*) FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
          WHERE upper(a->>'currency') = v_currency AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) n
            WHERE n->>'uid' = a->>'uid' OR (public.normalize_iban(n->>'iban')
              = public.normalize_iban(a->>'iban') AND upper(n->>'currency') = v_currency))) <> 1
        OR (SELECT count(*) FROM jsonb_array_elements(p_accounts) n
          WHERE upper(n->>'currency') = v_currency AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
            WHERE a->>'uid' = n->>'uid' OR (public.normalize_iban(n->>'iban')
              = public.normalize_iban(a->>'iban') AND upper(a->>'currency') = v_currency))) <> 1 THEN
        RAISE EXCEPTION 'BANK_CALLBACK_PAIRING_CHANGED' USING ERRCODE = 'PT409';
      END IF;
    END IF;
    IF v_prior IS NULL AND EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(v_connection.accounts_data,'[]')) a
      WHERE a->>'uid' = v_account->>'uid') THEN
      RAISE EXCEPTION 'BANK_CALLBACK_IDENTITY_CHANGED' USING ERRCODE = 'PT409';
    END IF;
    v_account := v_account - v_observations - 'ledger_account';
    IF v_prior IS NOT NULL THEN
      v_account := v_account || coalesce((SELECT jsonb_object_agg(key,value) FROM jsonb_each(v_prior) WHERE key = ANY(v_observations)),'{}');
      v_account := v_account || jsonb_build_object('enabled',coalesce((v_prior->>'enabled')::boolean,true),
        'dedup_scope',coalesce(nullif(v_prior->>'dedup_scope',''),public.normalize_iban(v_prior->>'iban'),v_prior->>'uid'));
      IF v_iban IS NULL AND nullif(v_prior->>'iban','') IS NOT NULL THEN
        v_account := v_account || jsonb_build_object('iban',v_prior->>'iban');
      END IF;
      IF nullif(v_prior->>'dedup_scope','') IS NOT NULL THEN v_preserve := array_append(v_preserve,v_account->>'uid'); END IF;
    END IF;
    SELECT m INTO v_mirror FROM jsonb_array_elements(p_mirrors) m WHERE m->>'uid' = v_account->>'uid';
    IF v_mirror IS NOT NULL THEN v_account := v_account || jsonb_build_object('ledger_account',v_mirror->>'ledger_account'); END IF;
    v_next := v_next || jsonb_build_array(v_account);
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_next) a WHERE (a->>'enabled')::boolean
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m WHERE m->>'uid' = a->>'uid')) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_MIRROR_MISSING' USING ERRCODE = 'PT409';
  END IF;

  FOR v_chart IN SELECT * FROM jsonb_populate_recordset(NULL::public.chart_of_accounts,p_chart_accounts) LOOP
    IF v_chart.account_number IS NULL OR v_chart.account_number !~ '^19[0-9]{2}$'
      OR v_chart.account_class IS DISTINCT FROM 1 OR v_chart.account_type IS DISTINCT FROM 'asset'
      OR v_chart.normal_balance IS DISTINCT FROM 'debit'
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m WHERE m->>'ledger_account' = v_chart.account_number) THEN
      RAISE EXCEPTION 'BANK_CALLBACK_CHART_INVALID' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.chart_of_accounts(company_id,user_id,account_number,account_name,account_class,account_group,
      account_type,normal_balance,sru_code,k2_excluded,plan_type,is_active,is_system_account,description,sort_order)
    VALUES(p_company_id,p_user_id,v_chart.account_number,v_chart.account_name,1,v_chart.account_group,
      'asset','debit',v_chart.sru_code,coalesce(v_chart.k2_excluded,false),'full_bas',true,false,v_chart.description,v_chart.sort_order)
    ON CONFLICT(company_id,account_number) DO NOTHING;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m WHERE NOT EXISTS(
    SELECT 1 FROM public.chart_of_accounts c WHERE c.company_id = p_company_id AND c.account_number = m->>'ledger_account')) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_CHART_ACCOUNT_MISSING' USING ERRCODE = '23514';
  END IF;
  UPDATE public.bank_connections SET session_id = p_session_id, status = 'pending_selection', accounts_data = v_next,
    consent_expires = p_consent_expires, oauth_state = NULL, error_message = NULL
    WHERE company_id = p_company_id AND id = p_connection_id;
  v_supersede := public.supersede_bank_connections(p_company_id,p_user_id,p_connection_id,
    public.bank_configuration_token(p_company_id),p_session_id,v_preserve);
  v_next := v_supersede->'accounts';

  -- Refuse an automatic takeover of a claim that the supersession decision
  -- did not release. Clear validated own reuse UIDs together so permutations
  -- do not collide halfway through promotion. All changes still roll back.
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_mirrors) m JOIN public.cash_accounts c
    ON c.id = nullif(m->>'reuse_cash_account_id','')::uuid LEFT JOIN public.bank_connections b ON b.id = c.bank_connection_id
    WHERE c.company_id <> p_company_id OR (c.bank_connection_id <> p_connection_id AND b.status <> 'revoked')) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_MIRROR_CLAIMED' USING ERRCODE = 'PT409';
  END IF;
  UPDATE public.cash_accounts SET external_uid = NULL WHERE company_id = p_company_id AND bank_connection_id = p_connection_id
    AND id IN (SELECT nullif(m->>'reuse_cash_account_id','')::uuid FROM jsonb_array_elements(p_mirrors) m);
  FOR v_mirror IN SELECT value FROM jsonb_array_elements(p_mirrors) LOOP
    SELECT a INTO v_account FROM jsonb_array_elements(v_next) a WHERE a->>'uid' = v_mirror->>'uid';
    PERFORM public.promote_psd2_cash_account(p_company_id,v_account || jsonb_build_object(
      'bank_connection_id',p_connection_id,'external_uid',v_account->>'uid',
      'reuse_cash_account_id',v_mirror->'reuse_cash_account_id','expected_session_id',p_session_id));
  END LOOP;
  RETURN jsonb_build_object('connection',jsonb_build_object('id',p_connection_id,'company_id',p_company_id,
      'user_id',p_user_id,'bank_name',v_connection.bank_name), 'old_session_id',v_connection.session_id,
    'accounts',(SELECT accounts_data FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id),
    'superseded',v_supersede->'superseded');
END;
$function$;

CREATE OR REPLACE FUNCTION public.finalize_open_payments_consent(p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_consent_id text, p_consent_expires timestamp with time zone, p_accounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
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
    v_iban := public.normalize_iban(v_account->>'iban');
    IF v_iban IS NOT NULL THEN
      SELECT array_agg(DISTINCT a->>'dedup_scope' ORDER BY a->>'dedup_scope') INTO v_scopes
      FROM public.bank_connections b CROSS JOIN LATERAL jsonb_array_elements(coalesce(b.accounts_data,'[]')) a
      WHERE b.company_id = p_company_id AND b.id <> p_connection_id AND b.aggregator <> 'open_payments'
        AND public.normalize_iban(a->>'iban') = v_iban
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

CREATE OR REPLACE FUNCTION public.guard_bank_booking_context()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
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
      PERFORM public.observe_cash_account_company(NEW.company_id);
    END IF;
    RETURN NEW;
  END IF;

  -- All posting participates in keeper-history serialization, including
  -- manual/import entries that do not originate from a bank transaction.
  PERFORM public.observe_cash_account_company(NEW.company_id);
  IF NEW.source_type = 'bank_transaction' AND (NEW.source_id IS NULL OR NOT (
    NEW.bank_booking_context @> jsonb_build_array(jsonb_build_object('transaction_id', NEW.source_id))
  )) THEN
    RAISE EXCEPTION 'BANK_BOOKING_CONTEXT_REQUIRED' USING ERRCODE = '23514';
  END IF;
  PERFORM public.validate_journal_bank_anchors(NEW.company_id, NEW.id);
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
  PERFORM 1 FROM public.bank_connections WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = NEW.company_id ORDER BY id FOR SHARE NOWAIT;
  PERFORM 1 FROM public.transactions t WHERE t.company_id = NEW.company_id
    AND t.id IN (SELECT (c->>'transaction_id')::uuid FROM jsonb_array_elements(NEW.bank_booking_context) c)
    ORDER BY t.id FOR UPDATE NOWAIT;

  FOR v_context IN SELECT c FROM jsonb_array_elements(NEW.bank_booking_context) c ORDER BY c->>'transaction_id' LOOP
    SELECT * INTO v_transaction FROM public.transactions
      WHERE company_id = NEW.company_id AND id = (v_context->>'transaction_id')::uuid;
    IF NOT FOUND OR v_transaction.cash_account_id IS DISTINCT FROM (v_context->>'cash_account_id')::uuid
      OR v_transaction.date IS DISTINCT FROM (v_context->>'date')::date
      OR v_transaction.amount IS DISTINCT FROM (v_context->>'amount')::numeric
      OR COALESCE(v_transaction.currency, 'SEK') IS DISTINCT FROM v_context->>'currency' THEN
      RAISE EXCEPTION 'BANK_BOOKING_SOURCE_CHANGED' USING ERRCODE = 'PT409';
    END IF;

    v_target_id := (v_context->>'target_cash_account_id')::uuid;
    IF v_target_id IS NOT NULL AND v_target_id IS DISTINCT FROM v_transaction.cash_account_id THEN
      SELECT * INTO v_cash FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id;
      SELECT * INTO v_target FROM public.cash_accounts WHERE company_id = NEW.company_id AND id = v_target_id;
      IF v_cash.id IS NULL OR v_target.id IS NULL OR NOT v_target.enabled
        OR public.normalize_iban(v_cash.iban) IS NULL
        OR public.normalize_iban(v_cash.iban) IS DISTINCT FROM public.normalize_iban(v_target.iban)
        OR v_cash.currency IS DISTINCT FROM v_target.currency
        OR v_target.currency IS DISTINCT FROM COALESCE(v_transaction.currency, 'SEK')
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
          AND public.normalize_iban(c.iban) = public.normalize_iban(v_cash.iban)
      )) THEN
        RAISE EXCEPTION 'BANK_BOOKING_REBIND_REFUSED' USING ERRCODE = '23514';
      END IF;
      UPDATE public.transactions SET cash_account_id = v_target_id WHERE company_id = NEW.company_id AND id = v_transaction.id;
      v_transaction.cash_account_id := v_target_id;
    END IF;

    IF v_transaction.cash_account_id IS NOT NULL THEN
      SELECT ledger_account INTO v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND id = v_transaction.cash_account_id AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF NOT FOUND THEN RAISE EXCEPTION 'BANK_BOOKING_CASH_ACCOUNT_MISSING' USING ERRCODE = '23514'; END IF;
    ELSE
      -- Match resolveSettlementAccount's existing unbound-row fallback.
      SELECT count(*), min(ledger_account) INTO v_count, v_ledger FROM public.cash_accounts
        WHERE company_id = NEW.company_id AND enabled AND kind = 'bank' AND currency = COALESCE(v_transaction.currency, 'SEK');
      IF v_count <> 1 THEN v_ledger := '1930'; END IF;
    END IF;
    IF v_ledger IS DISTINCT FROM v_context->>'settlement_account' OR NOT EXISTS (
      SELECT 1 FROM public.journal_entry_lines l WHERE l.journal_entry_id = NEW.id AND l.account_number = v_ledger
        AND ((v_transaction.amount < 0 AND l.credit_amount > 0) OR (v_transaction.amount > 0 AND l.debit_amount > 0))
    ) THEN
      RAISE EXCEPTION 'BANK_BOOKING_SETTLEMENT_CHANGED' USING ERRCODE = 'PT409';
    END IF;
  END LOOP;
  RETURN NEW;
EXCEPTION WHEN lock_not_available THEN
  RAISE EXCEPTION 'CASH_ACCOUNT_OPERATION_BUSY' USING ERRCODE = 'PT409';
END;
$function$;

CREATE OR REPLACE FUNCTION public.inspect_cash_account_routing(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
DECLARE
  v_connection public.bank_connections;
  v_entry jsonb;
  v_cash public.cash_accounts;
  v_count integer;
  v_reason text;
  v_issues jsonb := '[]';
BEGIN
  FOR v_connection IN SELECT * FROM public.bank_connections WHERE company_id = p_company_id
    AND status IN ('active','error') AND superseded_by IS NULL ORDER BY id
  LOOP
    FOR v_entry IN SELECT a FROM jsonb_array_elements(v_connection.accounts_data) a
      WHERE coalesce((a->>'enabled')::boolean, true) ORDER BY a->>'uid'
    LOOP
      v_reason := NULL;
      SELECT count(*) INTO v_count FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_entry->>'uid';
      SELECT * INTO v_cash FROM public.cash_accounts WHERE company_id = p_company_id
        AND bank_connection_id = v_connection.id AND external_uid = v_entry->>'uid';
      IF v_connection.session_id IS NULL THEN v_reason := 'missing-session';
      ELSIF v_entry->>'uid' IS NULL OR v_count <> 1 THEN v_reason := 'ambiguous-uid';
      ELSIF v_cash.id IS NULL THEN v_reason := 'missing-cash-account';
      ELSIF NOT v_cash.enabled THEN v_reason := 'disabled-cash-account';
      ELSIF upper(v_entry->>'currency') IS DISTINCT FROM v_cash.currency THEN v_reason := 'currency-mismatch';
      ELSIF v_entry->>'ledger_account' IS DISTINCT FROM v_cash.ledger_account THEN v_reason := 'ledger-mismatch';
      ELSIF nullif(v_entry->>'iban', '') IS NOT NULL AND
        public.normalize_iban(v_entry->>'iban') IS DISTINCT FROM
        public.normalize_iban(v_cash.iban) THEN v_reason := 'identity-mismatch';
      END IF;
      IF v_reason IS NOT NULL THEN
        v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', v_reason, 'connectionId', v_connection.id,
          'cashAccountId', v_cash.id, 'uidHash', public.cash_repair_state_hash(to_jsonb(v_entry->>'uid'))));
      END IF;
    END LOOP;
    FOR v_cash IN SELECT * FROM public.cash_accounts c WHERE c.company_id = p_company_id
      AND c.bank_connection_id = v_connection.id AND c.enabled AND NOT EXISTS (
        SELECT 1 FROM jsonb_array_elements(v_connection.accounts_data) a
        WHERE a->>'uid' = c.external_uid AND coalesce((a->>'enabled')::boolean, true)) ORDER BY c.id
    LOOP
      v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind', 'cash-account-not-selected',
        'connectionId', v_connection.id, 'cashAccountId', v_cash.id,
        'uidHash', public.cash_repair_state_hash(to_jsonb(v_cash.external_uid))));
    END LOOP;
  END LOOP;
  RETURN v_issues;
END;
$function$;

CREATE OR REPLACE FUNCTION public.inspect_historical_cash_twin_repair(p_company_id uuid, p_started_event_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
 SET "TimeZone" TO 'UTC'
AS $function$
DECLARE
  v_started public.processing_history; v_payload jsonb; v_base jsonb; v_completions jsonb;
  v_keeper public.cash_accounts; v_live public.cash_accounts; v_row public.cash_accounts;
  v_connection public.bank_connections; v_item jsonb; v_account jsonb;
  v_retired jsonb := '[]'; v_issues jsonb := '[]'; v_route jsonb := '{}';
  v_contradictory boolean := false; v_partial boolean := false; v_insufficient boolean := false;
  v_iban text; v_uid text; v_count bigint; v_movable bigint; v_total bigint; v_dependencies text[];
  v_uuid_regex constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
BEGIN
  SELECT * INTO v_started FROM public.processing_history WHERE company_id = p_company_id
    AND event_id = p_started_event_id AND event_type = 'CashAccountTwinsMerged' AND payload->>'phase' = 'started';
  IF NOT FOUND THEN RAISE EXCEPTION 'CASH_ACCOUNT_STARTED_EVENT_NOT_FOUND' USING ERRCODE = 'P0002'; END IF;
  SELECT coalesce(jsonb_agg(jsonb_build_object('eventId',event_id,'recordedAt',occurred_at) ORDER BY occurred_at,event_id),'[]')
    INTO v_completions FROM public.processing_history WHERE company_id = p_company_id
      AND event_type = 'CashAccountTwinsMerged' AND causation_id = p_started_event_id AND payload->>'phase' = 'completed';
  v_base := jsonb_build_object('companyId',p_company_id,'startedEventId',p_started_event_id,
    'startedAt',v_started.occurred_at,'observedAt',statement_timestamp(),'completionRecords',v_completions,
    'classification','insufficient-evidence','issues','[]'::jsonb,'retired','[]'::jsonb,'route','{}'::jsonb,
    'limitations',jsonb_build_array('current-state-only','original-provider-identity-not-recorded',
      'original-transaction-ids-and-bindings-not-recorded','original-primary-state-not-recorded',
      'original-journal-and-dependency-state-not-recorded','no-historical-completion-time-inferred'));
  v_payload := v_started.payload;
  IF jsonb_typeof(v_payload->'keeper') IS DISTINCT FROM 'object'
    OR coalesce(v_payload->'keeper'->>'id','') !~* v_uuid_regex
    OR coalesce(v_payload->'keeper'->>'ledger_account','') !~ '^[0-9]{4}$'
    OR coalesce(v_payload->>'live_row_id','') !~* v_uuid_regex
    OR coalesce(v_payload->>'bank_connection_id','') !~* v_uuid_regex
    OR v_payload->>'sync_ledger_after' IS DISTINCT FROM v_payload->'keeper'->>'ledger_account'
    OR (v_payload->>'sync_ledger_before' IS NOT NULL AND v_payload->>'sync_ledger_before' !~ '^[0-9]{4}$')
    OR jsonb_typeof(v_payload->'retired') IS DISTINCT FROM 'array' THEN
    RETURN v_base || jsonb_build_object('issues',jsonb_build_array(jsonb_build_object('kind','malformed-started-payload')));
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'retired') r WHERE jsonb_typeof(r) <> 'object'
    OR coalesce(r->>'id','') !~* v_uuid_regex OR coalesce(r->>'ledger_account','') !~ '^[0-9]{4}$'
    OR r->>'id' = v_payload->'keeper'->>'id'
    OR jsonb_typeof(r->'movable') IS DISTINCT FROM 'number' OR coalesce(r->>'movable','') !~ '^[0-9]{1,10}$'
    OR jsonb_typeof(r->'staying') IS DISTINCT FROM 'number' OR coalesce(r->>'staying','') !~ '^[0-9]{1,10}$'
    OR coalesce(r->>'outcome','') NOT IN ('rekeyed-into-keeper','deleted','demoted-to-manual','kept-manual'))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'retired') r GROUP BY r->>'id' HAVING count(*) > 1)
    OR (v_payload->>'live_row_id' <> v_payload->'keeper'->>'id' AND NOT EXISTS(
      SELECT 1 FROM jsonb_array_elements(v_payload->'retired') r WHERE r->>'id' = v_payload->>'live_row_id')) THEN
    RETURN v_base || jsonb_build_object('issues',jsonb_build_array(jsonb_build_object('kind','malformed-retirement-intent')));
  END IF;
  SELECT * INTO v_keeper FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_payload->'keeper'->>'id')::uuid;
  IF NOT FOUND THEN
    RETURN v_base || jsonb_build_object('classification','contradictory',
      'issues',jsonb_build_array(jsonb_build_object('kind','keeper-missing','id',v_payload->'keeper'->>'id')));
  END IF;
  v_base := v_base || jsonb_build_object('keeper',jsonb_build_object('id',v_keeper.id,
    'expectedLedger',v_payload->'keeper'->>'ledger_account','currentLedger',CASE WHEN v_keeper.ledger_account ~ '^[0-9]{4}$' THEN v_keeper.ledger_account END,'isPrimary',v_keeper.is_primary));
  IF v_keeper.ledger_account IS DISTINCT FROM v_payload->'keeper'->>'ledger_account' THEN
    v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-ledger-changed','id',v_keeper.id));
  END IF;
  v_iban := public.normalize_iban(v_keeper.iban);
  IF v_iban IS NULL THEN
    v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-physical-identity-unavailable','id',v_keeper.id));
  END IF;
  SELECT * INTO v_live FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_payload->>'live_row_id')::uuid;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = (v_payload->>'bank_connection_id')::uuid;
  v_route := jsonb_build_object('connectionId',v_payload->>'bank_connection_id','status',v_connection.status,
    'expectedLedger',v_payload->>'sync_ledger_after');
  IF v_connection.id IS NULL OR v_connection.status = 'revoked' OR v_connection.superseded_by IS NOT NULL OR v_connection.session_id IS NULL THEN
    v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','original-connection-no-longer-available','id',v_payload->>'bank_connection_id'));
  ELSIF jsonb_typeof(v_connection.accounts_data) IS DISTINCT FROM 'array' THEN
    v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','current-route-metadata-unavailable','id',v_connection.id));
  ELSE
    v_uid := CASE WHEN v_keeper.bank_connection_id = v_connection.id THEN v_keeper.external_uid
      WHEN v_live.bank_connection_id = v_connection.id THEN v_live.external_uid END;
    IF v_uid IS NOT NULL THEN
      SELECT count(*) INTO v_count FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_uid;
      SELECT a INTO v_account FROM jsonb_array_elements(v_connection.accounts_data) a WHERE a->>'uid' = v_uid;
    ELSE
      SELECT count(*) INTO v_count FROM jsonb_array_elements(v_connection.accounts_data) a
        WHERE upper(a->>'currency') = v_keeper.currency AND public.normalize_iban(a->>'iban') = v_iban;
      SELECT a INTO v_account FROM jsonb_array_elements(v_connection.accounts_data) a
        WHERE upper(a->>'currency') = v_keeper.currency AND public.normalize_iban(a->>'iban') = v_iban;
    END IF;
    IF v_count <> 1 OR nullif(v_account->>'uid','') IS NULL THEN
      v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','current-route-identity-ambiguous','id',v_connection.id));
    ELSE
      v_route := v_route || jsonb_build_object('currentLedger',CASE WHEN v_account->>'ledger_account' ~ '^[0-9]{4}$' THEN v_account->>'ledger_account' END,
        'keeperOwnsUid',coalesce(v_keeper.bank_connection_id = v_connection.id AND v_keeper.external_uid = v_account->>'uid',false));
      IF public.normalize_iban(v_account->>'iban') IS NULL THEN
        v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-physical-identity-unavailable','id',v_connection.id));
      ELSIF upper(v_account->>'currency') IS DISTINCT FROM v_keeper.currency
        OR (v_iban IS NOT NULL AND public.normalize_iban(v_account->>'iban') IS DISTINCT FROM v_iban) THEN
        v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-physical-identity-conflict','id',v_connection.id));
      END IF;
      IF (v_account ? 'enabled' AND jsonb_typeof(v_account->'enabled') IS DISTINCT FROM 'boolean') THEN
        v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-selection-unavailable','id',v_connection.id));
      ELSIF coalesce((v_account->>'enabled')::boolean,true) IS DISTINCT FROM v_keeper.enabled THEN
        v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-selection-conflict','id',v_keeper.id));
      END IF;
      IF v_account->>'ledger_account' IS DISTINCT FROM v_payload->>'sync_ledger_after' THEN
        IF v_account->>'ledger_account' IS NOT DISTINCT FROM v_payload->>'sync_ledger_before' THEN
          v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-still-at-recorded-before-state','id',v_connection.id));
        ELSE
          v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','route-outside-recorded-intent','id',v_connection.id));
        END IF;
      END IF;
      IF v_keeper.bank_connection_id IS DISTINCT FROM v_connection.id OR v_keeper.external_uid IS DISTINCT FROM v_account->>'uid' THEN
        IF v_keeper.bank_connection_id IS NOT NULL AND v_keeper.bank_connection_id <> v_connection.id THEN
          v_insufficient := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-now-on-another-connection','id',v_keeper.id));
        ELSE
          v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','keeper-provider-handover-incomplete','id',v_keeper.id));
        END IF;
      END IF;
    END IF;
  END IF;
  FOR v_item IN SELECT value FROM jsonb_array_elements(v_payload->'retired') ORDER BY value->>'id' LOOP
    SELECT * INTO v_row FROM public.cash_accounts WHERE company_id = p_company_id AND id = (v_item->>'id')::uuid;
    SELECT count(*),count(*) FILTER (WHERE public.cash_transaction_is_movable(p_company_id,t.id)) INTO v_total,v_movable
      FROM public.transactions t WHERE t.company_id = p_company_id AND t.cash_account_id = (v_item->>'id')::uuid;
    v_dependencies := coalesce(public.cash_account_retirement_dependencies(p_company_id,(v_item->>'id')::uuid),'{}');
    v_retired := v_retired || jsonb_build_array(jsonb_build_object('id',v_item->>'id','expectedLedger',v_item->>'ledger_account',
      'plannedOutcome',v_item->>'outcome','plannedMovable',v_item->'movable','plannedStaying',v_item->'staying',
      'exists',v_row.id IS NOT NULL,'currentLedger',CASE WHEN v_row.ledger_account ~ '^[0-9]{4}$' THEN v_row.ledger_account END,'currentMovable',v_movable,'currentStaying',v_total-v_movable,
      'hasProviderClaim',v_row.bank_connection_id IS NOT NULL OR v_row.external_uid IS NOT NULL,
      'isPrimary',v_row.is_primary,'dependencies',to_jsonb(v_dependencies)));
    IF v_row.id IS NULL THEN
      IF v_item->>'outcome' IN ('kept-manual','demoted-to-manual') OR (v_item->>'staying')::bigint > 0 THEN
        v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retained-row-missing','id',v_item->>'id'));
      END IF;
      CONTINUE;
    END IF;
    IF v_row.ledger_account IS DISTINCT FROM v_item->>'ledger_account' OR v_row.currency IS DISTINCT FROM v_keeper.currency
      OR (v_iban IS NOT NULL AND public.normalize_iban(v_row.iban) IS DISTINCT FROM v_iban) THEN
      v_contradictory := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retired-row-identity-conflict','id',v_row.id));
    END IF;
    IF v_item->>'outcome' = 'deleted' OR v_movable > 0 OR v_row.bank_connection_id IS NOT NULL OR v_row.external_uid IS NOT NULL OR v_row.is_primary THEN
      v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retirement-incomplete','id',v_row.id));
    END IF;
    IF v_item->>'outcome' <> 'kept-manual' AND cardinality(v_dependencies) > 0 THEN
      v_partial := true; v_issues := v_issues || jsonb_build_array(jsonb_build_object('kind','retirement-needs-dependency-review','id',v_row.id));
    END IF;
  END LOOP;
  RETURN v_base || jsonb_build_object('route',v_route,'retired',v_retired,'issues',v_issues,'classification',CASE
    WHEN v_contradictory THEN 'contradictory' WHEN v_insufficient THEN 'insufficient-evidence'
    WHEN v_partial THEN 'partial' ELSE 'consistent-with-completion' END);
END;
$function$;

CREATE OR REPLACE FUNCTION public.payment_order_payee_key(p_type text, p_bankgiro text, p_plusgiro text, p_clearing text, p_account text, p_iban text)
 RETURNS text
 LANGUAGE sql
 IMMUTABLE
 SET search_path TO ''
AS $function$
  SELECT CASE p_type
    WHEN 'bankgiro' THEN 'bankgiro:' || nullif(regexp_replace(coalesce(p_bankgiro, ''), '\D', '', 'g'), '')
    WHEN 'plusgiro' THEN 'plusgiro:' || nullif(regexp_replace(coalesce(p_plusgiro, ''), '\D', '', 'g'), '')
    WHEN 'bank_account' THEN 'bank_account:'
                             || nullif(regexp_replace(coalesce(p_clearing, ''), '\D', '', 'g'), '')
                             || ':' || nullif(regexp_replace(coalesce(p_account, ''), '\D', '', 'g'), '')
    WHEN 'iban' THEN 'iban:' || public.normalize_iban(p_iban)
  END
$function$;

CREATE OR REPLACE FUNCTION public.plan_cash_account_twins(p_company_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
 SET search_path TO ''
AS $function$
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
    'cash', (SELECT coalesce(jsonb_agg(to_jsonb(c) - public.cash_account_observation_keys() ORDER BY c.id), '[]')
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
    SELECT public.normalize_iban(iban) || ':' || upper(currency) AS physical_key,
      array_agg(id ORDER BY id) AS ids, array_agg(ledger_account ORDER BY ledger_account) AS ledgers
    FROM public.cash_accounts WHERE company_id = p_company_id
      AND public.normalize_iban(iban) IS NOT NULL
    GROUP BY public.normalize_iban(iban) || ':' || upper(currency)
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
              (nullif(a->>'iban', '') IS NOT NULL AND public.normalize_iban(a->>'iban')
                IS DISTINCT FROM public.normalize_iban(v_live.iban))))
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
$function$;

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
$function$;

CREATE OR REPLACE FUNCTION public.renew_shared_bank_connection(p_company_id uuid, p_connection_id uuid, p_source_connection_id uuid, p_old_session_id text, p_new_session_id text, p_consent_expires timestamp with time zone, p_session_accounts jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  v_connection public.bank_connections; v_cash public.cash_accounts;
  v_account jsonb; v_provider jsonb; v_next jsonb := '[]'; v_mirrors jsonb := '[]'; v_input jsonb;
  v_iban text; v_currency text; v_matches integer; v_remapped integer := 0; v_unmatched integer := 0;
BEGIN
  IF nullif(p_old_session_id,'') IS NULL OR nullif(p_new_session_id,'') IS NULL
    OR p_old_session_id = p_new_session_id OR p_connection_id = p_source_connection_id
    OR jsonb_typeof(p_session_accounts) IS DISTINCT FROM 'array'
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_session_accounts) a
      WHERE jsonb_typeof(a) <> 'object' OR nullif(a->>'uid','') IS NULL OR nullif(a->>'currency','') IS NULL)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(p_session_accounts) a GROUP BY a->>'uid' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'BANK_RENEWAL_INPUT_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM public.lock_cash_account_company(p_company_id);
  PERFORM 1 FROM public.bank_connections WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  PERFORM 1 FROM public.cash_accounts WHERE company_id = p_company_id ORDER BY id FOR UPDATE;
  SELECT * INTO v_connection FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id;
  IF NOT FOUND OR v_connection.session_id IS DISTINCT FROM p_old_session_id
    OR v_connection.status = 'revoked' OR v_connection.superseded_by IS NOT NULL THEN
    RETURN jsonb_build_object('applied',false,'reason','connection-changed');
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.bank_connections WHERE id = p_source_connection_id
    AND session_id = p_new_session_id AND status IN ('active','pending_selection') AND superseded_by IS NULL) THEN
    RAISE EXCEPTION 'BANK_RENEWAL_SOURCE_CHANGED' USING ERRCODE = 'PT409';
  END IF;

  FOR v_account IN SELECT value FROM jsonb_array_elements(v_connection.accounts_data) LOOP
    v_iban := public.normalize_iban(v_account->>'iban');
    v_currency := upper(v_account->>'currency');
    -- Prefer an unchanged provider UID with matching identity. Otherwise
    -- require exactly one IBAN + currency match. Ambiguity is a full refusal.
    SELECT count(*) INTO v_matches FROM jsonb_array_elements(p_session_accounts) a WHERE a->>'uid' = v_account->>'uid'
      AND upper(a->>'currency') = v_currency
      AND public.normalize_iban(a->>'iban') IS NOT DISTINCT FROM v_iban;
    IF v_matches = 1 THEN
      SELECT a INTO v_provider FROM jsonb_array_elements(p_session_accounts) a WHERE a->>'uid' = v_account->>'uid';
    ELSE
      SELECT count(*) INTO v_matches FROM jsonb_array_elements(p_session_accounts) a
        WHERE v_iban IS NOT NULL AND public.normalize_iban(a->>'iban') = v_iban
          AND upper(a->>'currency') = v_currency;
      IF v_matches > 1 THEN RAISE EXCEPTION 'BANK_RENEWAL_IDENTITY_AMBIGUOUS' USING ERRCODE = 'PT409'; END IF;
      IF v_matches = 1 THEN
        SELECT a INTO v_provider FROM jsonb_array_elements(p_session_accounts) a
          WHERE public.normalize_iban(a->>'iban') = v_iban AND upper(a->>'currency') = v_currency;
      ELSE
        -- A UID reused for another physical account cannot remain as an
        -- unmatched old route after switching to the new consent.
        IF EXISTS(SELECT 1 FROM jsonb_array_elements(p_session_accounts) a WHERE a->>'uid' = v_account->>'uid') THEN
          RAISE EXCEPTION 'BANK_RENEWAL_IDENTITY_CHANGED' USING ERRCODE = 'PT409';
        END IF;
        v_provider := NULL;
      END IF;
    END IF;
    IF v_provider IS NULL THEN
      v_unmatched := v_unmatched + 1;
      v_next := v_next || jsonb_build_array(v_account);
      CONTINUE;
    END IF;

    SELECT count(*) INTO v_matches FROM public.cash_accounts WHERE company_id = p_company_id
      AND bank_connection_id = p_connection_id AND external_uid = v_account->>'uid';
    IF v_matches > 1 THEN RAISE EXCEPTION 'BANK_RENEWAL_MIRROR_AMBIGUOUS' USING ERRCODE = 'PT409'; END IF;
    SELECT * INTO v_cash FROM public.cash_accounts WHERE company_id = p_company_id
      AND bank_connection_id = p_connection_id AND external_uid = v_account->>'uid';
    IF v_cash.id IS NOT NULL AND (v_cash.currency <> v_currency
      OR (nullif(v_account->>'ledger_account','') IS NOT NULL AND v_cash.ledger_account <> v_account->>'ledger_account')) THEN
      RAISE EXCEPTION 'BANK_RENEWAL_MIRROR_CHANGED' USING ERRCODE = 'PT409';
    END IF;
    IF v_provider->>'uid' <> v_account->>'uid' THEN v_remapped := v_remapped + 1; END IF;
    v_account := v_account || jsonb_build_object('uid',v_provider->>'uid');
    IF v_cash.id IS NOT NULL THEN v_account := v_account || jsonb_build_object('ledger_account',v_cash.ledger_account); END IF;
    v_next := v_next || jsonb_build_array(v_account);
    IF nullif(v_account->>'ledger_account','') IS NOT NULL THEN
      v_mirrors := v_mirrors || jsonb_build_array(v_account || jsonb_build_object(
        'bank_connection_id',p_connection_id,'external_uid',v_account->>'uid',
        'reuse_cash_account_id',v_cash.id,'expected_session_id',p_new_session_id));
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_next) a GROUP BY a->>'uid' HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'BANK_RENEWAL_UID_CONFLICT' USING ERRCODE = 'PT409';
  END IF;

  -- Clear only the UIDs whose current mirrors were identified above, so a
  -- provider UID permutation cannot collide halfway through the loop.
  UPDATE public.cash_accounts SET external_uid = NULL WHERE company_id = p_company_id AND id IN (
    SELECT (a->>'reuse_cash_account_id')::uuid FROM jsonb_array_elements(v_mirrors) a
    WHERE nullif(a->>'reuse_cash_account_id','') IS NOT NULL
  );
  UPDATE public.bank_connections SET session_id = p_new_session_id, consent_expires = p_consent_expires,
    accounts_data = v_next, status = CASE WHEN status IN ('expired','error') THEN 'active' ELSE status END,
    error_message = CASE WHEN status IN ('expired','error') THEN NULL ELSE error_message END
  WHERE company_id = p_company_id AND id = p_connection_id;
  FOR v_input IN SELECT value FROM jsonb_array_elements(v_mirrors) LOOP
    PERFORM public.promote_psd2_cash_account(p_company_id,v_input);
  END LOOP;
  RETURN jsonb_build_object('applied',true,'remapped',v_remapped,'unmatched',v_unmatched);
END;
$function$;

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
  IF public.normalize_iban(v_account->>'iban') IS NOT NULL
     AND public.normalize_iban(v_account->>'iban')
       IS DISTINCT FROM public.normalize_iban(v_cash.iban) THEN
    RAISE EXCEPTION 'BANK_INGEST_IDENTITY_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  v_token := md5(jsonb_build_array('bank-route-v1', p_company_id, v_connection.id,
    v_connection.session_id, p_account_uid, v_cash.id, v_cash.ledger_account,
    upper(v_cash.currency), public.normalize_iban(v_cash.iban),
    v_cash.bban, v_cash.enabled, v_account->>'enabled')::text);
  RETURN jsonb_build_object('connectionId', v_connection.id, 'sessionId', v_connection.session_id,
    'accountUid', p_account_uid, 'cashAccountId', v_cash.id, 'ledgerAccount', v_cash.ledger_account,
    'currency', upper(v_cash.currency), 'token', v_token,
    'aggregator', v_connection.aggregator, 'bic', v_connection.bic);
END;
$function$;

CREATE OR REPLACE FUNCTION public.save_bank_account_selection(p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_expected_token text, p_selections jsonb, p_chart_accounts jsonb DEFAULT '[]'::jsonb, p_initial_sync jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
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
  -- The first-sync window the user picked: {requested_from, lookback_days}.
  -- CASE, not OR: the casts run only on values the shape checks passed.
  IF p_initial_sync IS NOT NULL AND (CASE
      WHEN jsonb_typeof(p_initial_sync) IS DISTINCT FROM 'object' THEN true
      WHEN jsonb_typeof(p_initial_sync->'lookback_days') IS DISTINCT FROM 'number'
        OR (p_initial_sync->>'lookback_days') !~ '^[0-9]{1,3}$'
        OR coalesce(p_initial_sync->>'requested_from', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN true
      ELSE (p_initial_sync->>'lookback_days')::integer NOT BETWEEN 1 AND 365
        OR (p_initial_sync->>'requested_from')::date > current_date
    END) THEN
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
            OR (public.normalize_iban(c.iban) IS NOT NULL
              AND public.normalize_iban(c.iban)
                IS DISTINCT FROM public.normalize_iban(a->>'iban'))))
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
  -- The window is saved with the activation, before any sync attempt, and
  -- only while the first import is still owed: persist_bank_sync_result
  -- keeps the same rule, and a renewal with the import done keeps its own.
  UPDATE public.bank_connections SET accounts_data = v_next,
    status = CASE WHEN status = 'pending_selection' THEN 'active' ELSE status END,
    initial_sync_requested_from = CASE WHEN p_initial_sync IS NOT NULL AND status = 'pending_selection'
        AND initial_sync_completed_at IS NULL
      THEN (p_initial_sync->>'requested_from')::date ELSE initial_sync_requested_from END,
    initial_sync_lookback_days = CASE WHEN p_initial_sync IS NOT NULL AND status = 'pending_selection'
        AND initial_sync_completed_at IS NULL
      THEN (p_initial_sync->>'lookback_days')::integer ELSE initial_sync_lookback_days END
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

CREATE OR REPLACE FUNCTION public.supersede_bank_connections(p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_expected_token text, p_expected_session_id text, p_preserve_scope_uids text[] DEFAULT '{}'::text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
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
      WHERE public.normalize_iban(old_account->>'iban')
        = public.normalize_iban(new_account->>'iban')
      AND upper(coalesce(nullif(old_account->>'currency',''),'SEK')) = upper(coalesce(nullif(new_account->>'currency',''),'SEK')))
    OR (b.status <> 'active'
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(b.accounts_data) a WHERE public.normalize_iban(a->>'iban') IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_survivor.accounts_data) a WHERE public.normalize_iban(a->>'iban') IS NOT NULL)));
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
    v_iban := public.normalize_iban(v_account->>'iban');
    v_currency := upper(coalesce(nullif(v_account->>'currency',''),'SEK'));
    IF v_iban IS NOT NULL AND NOT (v_account->>'uid' = ANY(coalesce(p_preserve_scope_uids,'{}')))
      AND (nullif(v_account->>'dedup_scope','') IS NULL OR v_account->>'dedup_scope' IN (v_iban,v_account->>'uid')) THEN
      SELECT array_agg(DISTINCT a->>'dedup_scope' ORDER BY a->>'dedup_scope') INTO v_scopes
      FROM public.bank_connections b CROSS JOIN LATERAL jsonb_array_elements(b.accounts_data) a
      WHERE b.company_id = p_company_id AND b.id = ANY(v_ids)
        AND public.normalize_iban(a->>'iban') = v_iban
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

CREATE OR REPLACE FUNCTION public.supersede_enable_banking_connection(p_company_id uuid, p_user_id uuid, p_new uuid, p_old uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
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
    v_iban := public.normalize_iban(v_account->>'iban');
    v_currency := upper(coalesce(nullif(v_account->>'currency',''),'SEK'));
    IF v_iban IS NOT NULL
      AND (nullif(v_account->>'dedup_scope','') IS NULL OR v_account->>'dedup_scope' IN (v_iban,v_account->>'uid')) THEN
      SELECT array_agg(DISTINCT a->>'dedup_scope' ORDER BY a->>'dedup_scope') INTO v_scopes
      FROM jsonb_array_elements(coalesce(v_old.accounts_data,'[]')) a
      WHERE public.normalize_iban(a->>'iban') = v_iban
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
NOTIFY pgrst, 'reload schema';
