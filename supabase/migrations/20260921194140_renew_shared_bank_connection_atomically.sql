-- A shared consent renewal changes session, provider UIDs and cash mirrors
-- together. Selection, ledger ownership and observations come from current
-- locked sibling rows, never the callback's earlier account snapshot.
CREATE FUNCTION public.renew_shared_bank_connection(
  p_company_id uuid, p_connection_id uuid, p_source_connection_id uuid,
  p_old_session_id text, p_new_session_id text, p_consent_expires timestamptz,
  p_session_accounts jsonb
)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
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
    v_iban := nullif(upper(regexp_replace(v_account->>'iban','\s','','g')),'');
    v_currency := upper(v_account->>'currency');
    -- Prefer an unchanged provider UID with matching identity. Otherwise
    -- require exactly one IBAN + currency match. Ambiguity is a full refusal.
    SELECT count(*) INTO v_matches FROM jsonb_array_elements(p_session_accounts) a WHERE a->>'uid' = v_account->>'uid'
      AND upper(a->>'currency') = v_currency
      AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') IS NOT DISTINCT FROM v_iban;
    IF v_matches = 1 THEN
      SELECT a INTO v_provider FROM jsonb_array_elements(p_session_accounts) a WHERE a->>'uid' = v_account->>'uid';
    ELSE
      SELECT count(*) INTO v_matches FROM jsonb_array_elements(p_session_accounts) a
        WHERE v_iban IS NOT NULL AND nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban
          AND upper(a->>'currency') = v_currency;
      IF v_matches > 1 THEN RAISE EXCEPTION 'BANK_RENEWAL_IDENTITY_AMBIGUOUS' USING ERRCODE = 'PT409'; END IF;
      IF v_matches = 1 THEN
        SELECT a INTO v_provider FROM jsonb_array_elements(p_session_accounts) a
          WHERE nullif(upper(regexp_replace(a->>'iban','\s','','g')),'') = v_iban AND upper(a->>'currency') = v_currency;
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

-- Renewal is a cross-company system action after a verified callback, never
-- a client-controlled way to attach an arbitrary provider session.
REVOKE ALL ON FUNCTION public.renew_shared_bank_connection(uuid,uuid,uuid,text,text,timestamptz,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_shared_bank_connection(uuid,uuid,uuid,text,text,timestamptz,jsonb) TO service_role;
NOTIFY pgrst, 'reload schema';
