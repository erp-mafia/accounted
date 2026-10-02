-- Provider consents span companies. This system table has no tenant owner:
-- a committed revocation claim permanently prevents attaching that consent
-- again, including while provider HTTP is in flight or its result is unknown.
CREATE TABLE public.bank_session_revocations (
  provider text NOT NULL,
  session_id text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('pending','succeeded','failed')),
  claim_token uuid NOT NULL,
  lease_until timestamptz NOT NULL,
  attempts integer NOT NULL CHECK (attempts > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY(provider,session_id)
);
ALTER TABLE public.bank_session_revocations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.bank_session_revocations FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT ON public.bank_session_revocations TO service_role;
GRANT UPDATE(outcome,claim_token,lease_until,attempts,updated_at,completed_at) ON public.bank_session_revocations TO service_role;
CREATE TRIGGER update_bank_session_revocation_timestamp BEFORE UPDATE ON public.bank_session_revocations
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION public.lock_bank_provider_session(p_provider text,p_session_id text)
RETURNS void LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF nullif(p_provider,'') IS NULL OR nullif(p_session_id,'') IS NULL THEN
    RAISE EXCEPTION 'BANK_SESSION_ID_REQUIRED' USING ERRCODE = '22023';
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('bank-session:' || jsonb_build_array(p_provider,p_session_id)::text,0)) THEN
    RAISE EXCEPTION 'BANK_SESSION_BUSY' USING ERRCODE = 'PT409';
  END IF;
END;
$function$;

-- The trigger can read the service-only revocation marker but cannot change
-- it. Outer bank_connections RLS and the existing company writer guard still
-- authorize the row mutation. Sorted NOWAIT session locks avoid inversions
-- with callers that already own company or connection rows.
CREATE FUNCTION public.guard_bank_provider_session_claim()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $function$
DECLARE v_session record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.provider IS NOT DISTINCT FROM OLD.provider
    AND NEW.session_id IS NOT DISTINCT FROM OLD.session_id
    AND NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  FOR v_session IN SELECT DISTINCT provider,session_id FROM (
    SELECT CASE WHEN TG_OP <> 'INSERT' THEN OLD.provider END AS provider,
      CASE WHEN TG_OP <> 'INSERT' THEN OLD.session_id END AS session_id
    UNION ALL
    SELECT CASE WHEN TG_OP <> 'DELETE' THEN NEW.provider END,
      CASE WHEN TG_OP <> 'DELETE' THEN NEW.session_id END
  ) candidates WHERE session_id IS NOT NULL ORDER BY provider,session_id LOOP
    PERFORM public.lock_bank_provider_session(v_session.provider,v_session.session_id);
  END LOOP;
  IF TG_OP <> 'DELETE' AND NEW.session_id IS NOT NULL AND NEW.status <> 'revoked'
    AND EXISTS(SELECT 1 FROM public.bank_session_revocations WHERE provider = NEW.provider AND session_id = NEW.session_id) THEN
    RAISE EXCEPTION 'BANK_SESSION_REVOCATION_STARTED' USING ERRCODE = 'PT409';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER bank_provider_session_claim_guard BEFORE INSERT OR UPDATE OR DELETE ON public.bank_connections
  FOR EACH ROW EXECUTE FUNCTION public.guard_bank_provider_session_claim();

CREATE FUNCTION public.claim_bank_session_revocation(p_provider text,p_session_id text)
RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
DECLARE v_row public.bank_session_revocations; v_token uuid := gen_random_uuid();
BEGIN
  PERFORM public.lock_bank_provider_session(p_provider,p_session_id);
  IF EXISTS(SELECT 1 FROM public.bank_connections WHERE provider = p_provider AND session_id = p_session_id AND status <> 'revoked') THEN
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

CREATE FUNCTION public.finish_bank_session_revocation(p_provider text,p_session_id text,p_claim_token uuid,p_succeeded boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $function$
BEGIN
  IF p_succeeded IS NULL THEN RAISE EXCEPTION 'BANK_SESSION_OUTCOME_REQUIRED' USING ERRCODE = '22023'; END IF;
  PERFORM public.lock_bank_provider_session(p_provider,p_session_id);
  UPDATE public.bank_session_revocations SET outcome = CASE WHEN p_succeeded THEN 'succeeded' ELSE 'failed' END,
    completed_at = clock_timestamp(), lease_until = clock_timestamp()
  WHERE provider = p_provider AND session_id = p_session_id AND claim_token = p_claim_token AND outcome = 'pending';
  RETURN FOUND;
END;
$function$;

REVOKE ALL ON FUNCTION public.lock_bank_provider_session(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_bank_provider_session_claim() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_bank_session_revocation(text,text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.finish_bank_session_revocation(text,text,uuid,boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.lock_bank_provider_session(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_bank_session_revocation(text,text) TO service_role;
GRANT EXECUTE ON FUNCTION public.finish_bank_session_revocation(text,text,uuid,boolean) TO service_role;
NOTIFY pgrst, 'reload schema';
