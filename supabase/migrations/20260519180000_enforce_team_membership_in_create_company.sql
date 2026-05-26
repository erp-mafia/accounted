-- Migration: enforce team membership in create_company_with_owner
--
-- 20260519170000_fix_create_company_with_owner_overload.sql re-introduced the
-- 4-arg RPC but the team-association path performs no authorization check on
-- p_team_id. A SECURITY DEFINER function that accepts a team_id from an
-- authenticated user must verify the caller is a member of that team — RLS
-- on companies.team_id would normally guard this, but the INSERT runs as the
-- definer role and bypasses RLS.
--
-- Without this check, any authenticated user can attach a freshly-created
-- company to a team they do not belong to. Team-member sync would then leak
-- a team's other consultants into a company they had no relationship with
-- (OWASP ASVS V8.2.1).
--
-- Fix: assert (auth.uid()) has a team_members row for p_team_id before
-- inserting. Team owners are stored as team_members rows with role='owner'
-- (see 20260331010000_teams_table_refactor.sql section 3c), so the single
-- team_members lookup covers both owners and members.

CREATE OR REPLACE FUNCTION public.create_company_with_owner(
  p_name text,
  p_entity_type text,
  p_set_active boolean DEFAULT true,
  p_team_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
  v_company_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  IF p_entity_type NOT IN ('enskild_firma', 'aktiebolag') THEN
    RAISE EXCEPTION 'Invalid entity_type: %', p_entity_type;
  END IF;

  -- Authorize p_team_id before any write. SECURITY DEFINER bypasses RLS, so
  -- we must verify membership ourselves; without this any authenticated user
  -- could attach a company to an arbitrary team.
  IF p_team_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1
      FROM public.team_members
      WHERE team_id = p_team_id
        AND user_id = v_user_id
    ) THEN
      RAISE EXCEPTION 'Not a member of team %', p_team_id
        USING ERRCODE = '42501'; -- insufficient_privilege
    END IF;
  END IF;

  INSERT INTO public.companies (name, entity_type, created_by, team_id)
  VALUES (p_name, p_entity_type, v_user_id, p_team_id)
  RETURNING id INTO v_company_id;

  INSERT INTO public.company_members (company_id, user_id, role)
  VALUES (v_company_id, v_user_id, 'owner');

  -- Seed default 1930 SEK cash account so reconciliation routes work before
  -- any PSD2 connection is established. is_primary so the __PRIMARY_SEK__
  -- sentinel in skattekonto-booking resolves on day one.
  INSERT INTO public.cash_accounts (
    company_id, ledger_account, currency, name, enabled, is_primary, source
  )
  VALUES (
    v_company_id, '1930', 'SEK', 'Företagskonto (SEK)', true, true, 'manual'
  )
  ON CONFLICT (company_id, ledger_account) DO NOTHING;

  IF p_set_active THEN
    INSERT INTO public.user_preferences (user_id, active_company_id)
    VALUES (v_user_id, v_company_id)
    ON CONFLICT (user_id)
    DO UPDATE SET active_company_id = EXCLUDED.active_company_id;
  END IF;

  IF p_team_id IS NOT NULL THEN
    PERFORM public.sync_team_to_company(v_company_id, p_team_id);
  END IF;

  RETURN v_company_id;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_company_with_owner(text, text, boolean, uuid) TO authenticated;

NOTIFY pgrst, 'reload schema';
