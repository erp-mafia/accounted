-- A bank consent can be renewed by another member than the one who first
-- connected the bank.
--
-- What happened. An in-place renewal reuses the bank_connections row, and the
-- row's user_id (whose consent the row holds) doubled as "who started this
-- login": the callback bound the returning browser to it, and
-- read_bank_callback_configuration and finalize_bank_callback refused any
-- other actor. A second member who renewed a colleague's connection signed at
-- the bank and was then refused, and the connection stayed dead until the
-- first member renewed it.
--
-- What changes.
--   1. bank_connections.oauth_user_id names who started the pending login.
--      It is attempt state like oauth_state: written with it, read only next
--      to it, cleared when the login completes. A value an abandoned login
--      leaves behind is overwritten by the next login on the row.
--   2. Both functions accept the starter. The holder (user_id) is accepted as
--      before, so a login staged without a starter completes as it did: a row
--      in flight when this lands, or an app version that does not write the
--      column. Anyone else is refused, and so is a starter who is no longer a
--      member with write access.
--   3. finalize_bank_callback moves the row to the actor in the statement
--      that stores the new consent. user_id says whose consent the row holds,
--      and session reuse across one person's companies reads it, so it may
--      only change together with the consent: moved when the login starts, an
--      abandoned login would leave one person's consent under another's name.
--
-- The foreign key never cascades in the hosted service (account deletion
-- keeps auth.users as a tombstone); tests/pg/account-erasure.pg.test.ts
-- classifies the column.
--
-- read_bank_callback_configuration below is the definition of
-- 20260922075430_finalize_bank_callback_atomically.sql with the actor check
-- changed. finalize_bank_callback is the definition of
-- 20261110120000_bank_renewal_releases_dropped_account.sql with the actor
-- check and the final UPDATE of bank_connections changed.
--
-- pg-test: tests/pg/bank-callback-renewal-by-another-member.pg.test.ts

ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS oauth_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bank_connections.oauth_user_id IS
  'Who started the pending bank login (the one oauth_state belongs to). The callback binds the returning browser to this user, and finalize_bank_callback moves user_id to them with the new consent. Read only together with oauth_state: a value left by a login that never completed is overwritten by the next one. NULL when the login was staged without a starter.';

CREATE OR REPLACE FUNCTION public.read_bank_callback_configuration(
  p_company_id uuid, p_user_id uuid, p_connection_id uuid, p_oauth_state text
)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM public.bank_connections WHERE id = p_connection_id AND company_id = p_company_id
    AND (oauth_user_id = p_user_id OR user_id = p_user_id)
    AND oauth_state = p_oauth_state AND status IN ('pending','expired','error') AND superseded_by IS NULL)
    OR NOT EXISTS(SELECT 1 FROM public.company_members WHERE company_id = p_company_id AND user_id = p_user_id
      AND role IN ('owner','admin','member')) THEN
    RAISE EXCEPTION 'BANK_CALLBACK_CHANGED' USING ERRCODE = 'PT409';
  END IF;
  RETURN public.read_bank_configuration(p_company_id,p_connection_id);
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
  -- The actor started this login, or holds the consent the row carries.
  IF (p_user_id IS DISTINCT FROM v_connection.oauth_user_id AND p_user_id IS DISTINCT FROM v_connection.user_id)
    OR v_connection.oauth_state IS DISTINCT FROM p_oauth_state
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
    consent_expires = p_consent_expires, oauth_state = NULL, error_message = NULL,
    -- The consent stored here is the actor's: the row changes hands with it.
    user_id = p_user_id, oauth_user_id = NULL
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

  -- Every account the new consent lists was re-keyed above. A row still bound
  -- here under any other uid is an account the consent left out: release it
  -- as disconnect_bank_connection does, keeping the row and all its history.
  UPDATE public.cash_accounts c SET bank_connection_id = NULL, external_uid = NULL
    WHERE c.company_id = p_company_id AND c.bank_connection_id = p_connection_id
    AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(p_accounts) a WHERE a->>'uid' = c.external_uid);
  RETURN jsonb_build_object('connection',jsonb_build_object('id',p_connection_id,'company_id',p_company_id,
      'user_id',p_user_id,'bank_name',v_connection.bank_name), 'old_session_id',v_connection.session_id,
    'accounts',(SELECT accounts_data FROM public.bank_connections WHERE company_id = p_company_id AND id = p_connection_id),
    'superseded',v_supersede->'superseded');
END;
$function$;

NOTIFY pgrst, 'reload schema';
