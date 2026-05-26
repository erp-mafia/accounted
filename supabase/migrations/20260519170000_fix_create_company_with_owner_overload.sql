-- Migration: fix create_company_with_owner overload ambiguity
--
-- Background: 20260331010000_teams_table_refactor.sql defined the canonical
-- 4-arg signature:
--   create_company_with_owner(p_name text, p_entity_type text,
--                             p_set_active boolean DEFAULT true,
--                             p_team_id uuid DEFAULT NULL)
--
-- 20260519154732_seed_default_cash_account.sql then issued a CREATE OR REPLACE
-- with a 3-arg signature (dropping p_team_id) to add cash_accounts seeding.
-- CREATE OR REPLACE only matches when the parameter list is identical, so the
-- 3-arg form was created as a *new* overload rather than replacing the 4-arg
-- one. Both functions now coexist in production and both can be called with
-- two args (the third has a default), so PostgREST cannot resolve the call
-- and returns 300 Multiple Choices for any 2-arg invocation — breaking
-- /api/sandbox/seed (POST /rpc/create_company_with_owner failed with 300).
--
-- Fix: drop the 3-arg orphan and re-create the canonical 4-arg version with
-- the cash_accounts seeding merged in.

DROP FUNCTION IF EXISTS public.create_company_with_owner(text, text, boolean);

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
