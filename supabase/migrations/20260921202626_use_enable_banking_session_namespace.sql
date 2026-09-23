-- bank_connections.provider is the ASPSP/bank label, not the upstream
-- service namespace. Every session on this table belongs to Enable Banking,
-- so revocation and attachment must use the same key across all bank labels.
CREATE OR REPLACE FUNCTION public.guard_bank_provider_session_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_session text;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.session_id IS NOT DISTINCT FROM OLD.session_id
    AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  FOR v_session IN SELECT DISTINCT session_id FROM unnest(ARRAY[
    CASE WHEN TG_OP <> 'INSERT' THEN OLD.session_id END,
    CASE WHEN TG_OP <> 'DELETE' THEN NEW.session_id END
  ]) session_id WHERE session_id IS NOT NULL ORDER BY session_id LOOP
    PERFORM public.lock_bank_provider_session('enablebanking',v_session);
  END LOOP;
  IF TG_OP <> 'DELETE' AND NEW.session_id IS NOT NULL AND NEW.status <> 'revoked'
    AND EXISTS(SELECT 1 FROM public.bank_session_revocations
      WHERE provider = 'enablebanking' AND session_id = NEW.session_id) THEN
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
  IF p_provider IS DISTINCT FROM 'enablebanking' THEN
    RAISE EXCEPTION 'BANK_SESSION_PROVIDER_INVALID' USING ERRCODE = '22023';
  END IF;
  PERFORM public.lock_bank_provider_session(p_provider,p_session_id);
  IF EXISTS(SELECT 1 FROM public.bank_connections WHERE session_id = p_session_id AND status <> 'revoked') THEN
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
  IF p_provider IS DISTINCT FROM 'enablebanking' THEN
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
NOTIFY pgrst, 'reload schema';
