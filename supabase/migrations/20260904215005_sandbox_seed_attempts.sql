-- A settings row is created before demo data and is not a completion marker.
-- User-scoped coordination also covers the first request, before a company exists.
CREATE TABLE public.sandbox_seed_attempts (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  company_id uuid REFERENCES public.companies(id) ON DELETE SET NULL,
  attempt_id uuid NOT NULL DEFAULT gen_random_uuid(),
  status text NOT NULL CHECK (status IN ('running', 'failed', 'complete')),
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sandbox_seed_attempts_company_id ON public.sandbox_seed_attempts(company_id);
ALTER TABLE public.sandbox_seed_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sandbox_seed_attempts FROM anon, authenticated;
GRANT SELECT ON public.sandbox_seed_attempts TO authenticated;
CREATE POLICY sandbox_seed_attempts_read_own ON public.sandbox_seed_attempts
  FOR SELECT TO authenticated USING (user_id = (SELECT auth.uid()));
CREATE TRIGGER sandbox_seed_attempts_updated_at BEFORE UPDATE ON public.sandbox_seed_attempts
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

CREATE FUNCTION public.claim_sandbox_seed()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  v_user uuid := auth.uid();
  v_attempt public.sandbox_seed_attempts%ROWTYPE;
  v_company uuid;
  v_complete boolean := false;
BEGIN
  -- Read the server-owned auth record, not editable user_metadata.
  IF v_user IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth.users WHERE id = v_user AND is_anonymous IS TRUE
  ) THEN
    RAISE EXCEPTION 'Sandbox requires an anonymous user' USING ERRCODE = '42501';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('sandbox-seed:' || v_user::text, 0));
  SELECT * INTO v_attempt FROM public.sandbox_seed_attempts WHERE user_id = v_user FOR UPDATE;
  IF FOUND THEN
    IF v_attempt.status = 'running' AND v_attempt.started_at > now() - interval '15 minutes' THEN
      RETURN jsonb_build_object('status', 'busy');
    END IF;
    v_company := v_attempt.company_id;
    v_complete := v_attempt.status = 'complete';
  ELSE
    SELECT active_company_id INTO v_company FROM public.user_preferences WHERE user_id = v_user;
    -- Legacy successful seeds ended by linking all three payroll vouchers.
    -- Older or partial demos without that evidence are conservatively replaced.
    SELECT EXISTS (
      SELECT 1 FROM public.salary_runs sr
      JOIN public.journal_entries s ON s.id = sr.salary_entry_id AND s.company_id = sr.company_id AND s.status = 'posted'
      JOIN public.journal_entries a ON a.id = sr.avgifter_entry_id AND a.company_id = sr.company_id AND a.status = 'posted'
      JOIN public.journal_entries v ON v.id = sr.vacation_entry_id AND v.company_id = sr.company_id AND v.status = 'posted'
      WHERE sr.company_id = v_company AND sr.status = 'booked'
    ) INTO v_complete;
  END IF;

  IF v_company IS NOT NULL THEN
    -- Never archive, adopt or seed a real/shared company, even for an anonymous caller.
    IF NOT EXISTS (
      SELECT 1 FROM public.companies c JOIN public.company_members cm ON cm.company_id = c.id
      WHERE c.id = v_company AND c.created_by = v_user
        AND cm.user_id = v_user AND cm.role = 'owner'
    ) OR EXISTS (
      SELECT 1 FROM public.company_members WHERE company_id = v_company AND user_id <> v_user
    ) OR EXISTS (
      SELECT 1 FROM public.company_settings WHERE company_id = v_company AND is_sandbox IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'Not an exclusively owned sandbox company' USING ERRCODE = '42501';
    END IF;
    IF v_complete AND EXISTS (
      SELECT 1 FROM public.companies c JOIN public.company_settings cs ON cs.company_id = c.id
      WHERE c.id = v_company AND c.archived_at IS NULL AND cs.is_sandbox
    ) THEN
      INSERT INTO public.sandbox_seed_attempts(user_id, company_id, status, completed_at)
      VALUES (v_user, v_company, 'complete', now())
      ON CONFLICT (user_id) DO NOTHING;
      INSERT INTO public.user_preferences(user_id, active_company_id) VALUES (v_user, v_company)
      ON CONFLICT (user_id) DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
      RETURN jsonb_build_object('status', 'complete', 'company_id', v_company);
    END IF;
    -- Preserve partial entries and documents; ordinary sandbox expiry owns deletion.
    UPDATE public.companies SET archived_at = now(), archived_by = v_user
    WHERE id = v_company AND archived_at IS NULL;
  END IF;

  v_company := public.create_company_with_owner('Sandlådan Konsult', 'enskild_firma', true);
  -- Make even a crash before the first seed write discoverable by sandbox cleanup.
  INSERT INTO public.company_settings(user_id, company_id, is_sandbox)
  VALUES (v_user, v_company, true);
  INSERT INTO public.sandbox_seed_attempts(user_id, company_id, status)
  VALUES (v_user, v_company, 'running')
  ON CONFLICT (user_id) DO UPDATE SET company_id = EXCLUDED.company_id,
    attempt_id = gen_random_uuid(), status = 'running', started_at = now(), completed_at = NULL
  RETURNING * INTO v_attempt;
  RETURN jsonb_build_object('status', 'running', 'company_id', v_company, 'attempt_id', v_attempt.attempt_id);
END;
$$;

CREATE FUNCTION public.finish_sandbox_seed(p_attempt_id uuid, p_success boolean)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM auth.users WHERE id = auth.uid() AND is_anonymous IS TRUE
  ) THEN
    RAISE EXCEPTION 'Sandbox requires an anonymous user' USING ERRCODE = '42501';
  END IF;
  UPDATE public.sandbox_seed_attempts
    SET status = CASE WHEN p_success THEN 'complete' ELSE 'failed' END,
        completed_at = CASE WHEN p_success THEN now() ELSE NULL END
    WHERE user_id = auth.uid() AND attempt_id = p_attempt_id AND status = 'running';
  RETURN FOUND;
END;
$$;
REVOKE ALL ON FUNCTION public.claim_sandbox_seed() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.finish_sandbox_seed(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.claim_sandbox_seed() TO authenticated;
GRANT EXECUTE ON FUNCTION public.finish_sandbox_seed(uuid, boolean) TO authenticated;
NOTIFY pgrst, 'reload schema';
