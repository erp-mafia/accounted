-- Migration: byrå admin gate for create_company_for_user (WL-15)
--
-- 20260826130400 added the byrå owner/admin gate to create_company_with_owner,
-- but main's newer service-role variant create_company_for_user (20260825120000,
-- used by POST /api/v1/companies and the MCP gnubok_create_company tool) still
-- authorizes p_team_id with a membership-only EXISTS. Any plain byrå team
-- member could therefore bind a company to the byrå team through the API/MCP
-- path, which is a commercial act: every created client company is +1 on the
-- byrå's monthly invoice, and the byrå trial-suppression trigger then kills
-- the company's trial grants.
--
-- This replaces the function with the exact gate from 20260826130400: when the
-- target team has kind = 'byra', the owner (p_user_id, the API key's user)
-- must hold team_members.role owner/admin. Personal-team behavior is
-- unchanged: any member may attach. Everything else (validation, inserts,
-- cash-account seed, preference upsert, team sync, grants) is byte-identical
-- to 20260825120000.

CREATE OR REPLACE FUNCTION public.create_company_for_user(
  p_user_id uuid,
  p_name text,
  p_entity_type text,
  p_team_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_id uuid;
  v_team_kind text;
  v_team_role text;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'p_user_id is required';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'Unknown user %', p_user_id
      USING ERRCODE = '23503'; -- foreign_key_violation
  END IF;

  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  IF p_name IS NULL OR length(btrim(p_name)) = 0 THEN
    RAISE EXCEPTION 'p_name is required';
  END IF;

  -- Same authorization as create_company_with_owner (20260826130400), against
  -- the explicit owner: SECURITY DEFINER bypasses RLS, so team membership is
  -- checked here. On byrå teams the bar is higher: WL-15 locks client company
  -- creation to team owner/admin because every created company is +1 on the
  -- byrå's invoice.
  IF p_team_id IS NOT NULL THEN
    SELECT tm.role, t.kind
    INTO v_team_role, v_team_kind
    FROM public.team_members tm
    JOIN public.teams t ON t.id = tm.team_id
    WHERE tm.team_id = p_team_id
      AND tm.user_id = p_user_id;

    IF v_team_role IS NULL THEN
      RAISE EXCEPTION 'Not a member of team %', p_team_id
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;

    IF v_team_kind = 'byra' AND v_team_role NOT IN ('owner', 'admin') THEN
      RAISE EXCEPTION 'Only byrå team owners and admins can create client companies'
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (btrim(p_name), p_entity_type, p_user_id, p_team_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, p_user_id, 'owner');

  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  INSERT INTO public.user_preferences (user_id, active_company_id)
  VALUES (p_user_id, v_company_id)
  ON CONFLICT (user_id)
  DO UPDATE SET active_company_id = EXCLUDED.active_company_id;

  IF p_team_id IS NOT NULL THEN
    PERFORM public.sync_team_to_company(v_company_id, p_team_id);
  END IF;

  RETURN v_company_id;
END;
$$;

-- Service role only. PostgREST exposes functions to every role by default
-- (PUBLIC grant), so revoke first, then grant the one role that may call it.
REVOKE ALL ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) FROM anon;
REVOKE ALL ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_company_for_user(uuid, text, text, uuid) TO service_role;

NOTIFY pgrst, 'reload schema';
