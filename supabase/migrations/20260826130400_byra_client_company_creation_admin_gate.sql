-- Migration: byrå client company creation is admin-gated (WL-15)
--
-- Cockpit slice D3 (dev_docs/white-label/tickets/WL-15): creating a client
-- company under a byrå team is a commercial act (+1 on the byrå's monthly
-- invoice), so only team OWNERS and ADMINS may do it. Plain members keep
-- read/work access to client companies via the sync triggers but cannot
-- create new ones.
--
-- The gate must live in the database: create_company_with_owner is a
-- SECURITY DEFINER RPC granted to `authenticated`, so any byrå member could
-- otherwise call it directly through PostgREST with the byrå p_team_id and
-- bypass every application-level check.
--
-- Behavior for personal teams is byte-identical to
-- 20260519180000_enforce_team_membership_in_create_company.sql: any member
-- of a personal team may attach a company to it (in practice the sole owner;
-- ensure_user_team creates one personal team per user). Only teams with
-- kind = 'byra' (20260826130100) get the stricter role check.

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
  v_team_kind text;
  v_team_role text;
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
  -- could attach a company to an arbitrary team (20260519180000). On byrå
  -- teams the bar is higher: WL-15 locks client company creation to team
  -- owner/admin because every created company is +1 on the byrå's invoice.
  IF p_team_id IS NOT NULL THEN
    SELECT tm.role, t.kind
    INTO v_team_role, v_team_kind
    FROM public.team_members tm
    JOIN public.teams t ON t.id = tm.team_id
    WHERE tm.team_id = p_team_id
      AND tm.user_id = v_user_id;

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
