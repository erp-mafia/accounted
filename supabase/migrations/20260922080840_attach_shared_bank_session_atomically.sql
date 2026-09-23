-- Session reuse is a checked insertion, not a new bank authorization. Lock
-- every company visible to the actor before evaluating current IBAN claims.
CREATE FUNCTION public.attach_shared_bank_session(p_company_id uuid, p_user_id uuid, p_source_connection_id uuid)
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
    AND superseded_by IS NULL;
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
REVOKE ALL ON FUNCTION public.attach_shared_bank_session(uuid,uuid,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.attach_shared_bank_session(uuid,uuid,uuid) TO service_role;
NOTIFY pgrst, 'reload schema';
