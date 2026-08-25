-- Migration: create_company_for_user (service-role company creation)
--
-- Agent-first onboarding (issue #1814 PR 3): the MCP tool gnubok_create_company
-- and POST /api/v1/companies create companies on behalf of the API key's
-- user. Both run with a service-role client, where auth.uid() is NULL, so
-- create_company_with_owner (which derives the owner from auth.uid()) cannot
-- be used. This variant takes the owner explicitly and is callable by
-- service_role ONLY: an authenticated or anonymous caller must never be able
-- to create a company for someone else.
--
-- Body mirrors create_company_with_owner (20260519180000) step for step:
-- entity_type whitelist, team-membership authorization for p_team_id, the
-- companies + company_members inserts, the 1930 SEK cash account seed, the
-- active-company preference, and team sync. The trial capability grant is
-- minted by the AFTER INSERT trigger on companies, same as every other path.

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

  -- Same authorization as create_company_with_owner, against the explicit
  -- owner: SECURITY DEFINER bypasses RLS, so team membership is checked here.
  IF p_team_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.team_members
      WHERE team_id = p_team_id
        AND user_id = p_user_id
    ) THEN
      RAISE EXCEPTION 'Not a member of team %', p_team_id
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
