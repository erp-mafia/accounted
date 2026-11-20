-- Migration: an allowlisted byrå person joins the byrå team on their own
--
-- A white-label brand puts its byrå's people on brand_signup_allowlist so they
-- can create an account on the brand domain. The allowlist only opened the
-- door: membership of the byrå team was a separate team_members insert that
-- ops did by hand after noticing the signup. Owners who signed up waited
-- without the byrå view until then, and their clients' companies were already
-- sitting in the team.
--
-- The allowlist now says what the person is, not only that they may sign up:
--
--   1. brand_signup_allowlist.team_role ('owner' | 'admin' | 'member', NULL =
--      a cold signup only, no team membership). NULL is what every row the
--      byrå cockpit writes stays: those rows let a CLIENT sign up and create
--      their company in the team (create_company_for_brand_signup), and a
--      client must never become a member of the byrå team.
--   2. Backfill: rows ops wrote as note 'Byrå owner' (the white-label setup's
--      marker) become 'owner'.
--   3. One rule, two moments: a person whose CONFIRMED login address has an
--      allowlist row with a team_role is a member of that brand's team with
--      that role.
--        - auth.users: on insert with a confirmed address (Google), when the
--          address is confirmed (email link, BankID confirmation mail, invite)
--          and when a confirmed account changes its address (the change is
--          itself confirmed by Supabase Auth before `email` is written).
--        - brand_signup_allowlist: when a row gets a team_role and a confirmed
--          account with that address already exists.
--      An existing membership is never changed: no promotion, no demotion.
--   4. Only ops (service role, SQL) may set team_role. The cockpit's insert
--      policy now requires team_role IS NULL, so a byrå admin cannot add an
--      address that would turn into a team owner on signup (only an owner may
--      add an owner, enforce_team_member_role_transitions).
--
-- A failure in the join must never block a signup or a confirmation: the
-- auth.users trigger catches it and leaves a WARNING in the database log.
--
-- pg-test: tests/pg/allowlist-team-role-auto-join.pg.test.ts

-- =============================================================================
-- 1. brand_signup_allowlist.team_role
-- =============================================================================

ALTER TABLE public.brand_signup_allowlist
  ADD COLUMN team_role text;

ALTER TABLE public.brand_signup_allowlist
  ADD CONSTRAINT brand_signup_allowlist_team_role_check
  CHECK (team_role IS NULL OR team_role IN ('owner', 'admin', 'member'));

COMMENT ON COLUMN public.brand_signup_allowlist.team_role IS
  'NULL: the address may sign up on the brand domain (a client), nothing more. '
  'owner/admin/member: the address belongs to the byrå and joins the brand''s '
  'team with this role as soon as an account with it is confirmed '
  '(join_byra_teams_for_user). Set by ops only; the cockpit insert policy '
  'requires NULL.';

-- =============================================================================
-- 2. The join
-- =============================================================================

-- Joins a user to every byrå team whose brand allowlists the user's confirmed
-- login address with a team_role. Reads the address and its confirmation from
-- auth.users itself, so a call can only grant what the allowlist already
-- grants that very account. Idempotent: an existing membership is left as it
-- is. When one team has several matching rows (two brands, one team), the
-- strongest role wins.
CREATE OR REPLACE FUNCTION public.join_byra_teams_for_user(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  SELECT lower(u.email) INTO v_email
  FROM auth.users u
  WHERE u.id = p_user_id
    AND u.email_confirmed_at IS NOT NULL;

  IF v_email IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO public.team_members (team_id, user_id, role)
  SELECT DISTINCT ON (b.team_id) b.team_id, p_user_id, a.team_role
  FROM public.brand_signup_allowlist a
  JOIN public.brands b ON b.id = a.brand_id
  WHERE a.email = v_email
    AND a.team_role IS NOT NULL
  ORDER BY b.team_id,
    CASE a.team_role WHEN 'owner' THEN 1 WHEN 'admin' THEN 2 ELSE 3 END
  ON CONFLICT (team_id, user_id) DO NOTHING;
END;
$$;

REVOKE ALL ON FUNCTION public.join_byra_teams_for_user(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_byra_teams_for_user(uuid) FROM anon;
REVOKE ALL ON FUNCTION public.join_byra_teams_for_user(uuid) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.join_byra_teams_for_user(uuid) TO service_role;

-- =============================================================================
-- 3a. auth.users: a confirmed address joins its teams
-- =============================================================================

CREATE OR REPLACE FUNCTION public.join_byra_teams_on_confirmed_email()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  BEGIN
    PERFORM public.join_byra_teams_for_user(NEW.id);
  EXCEPTION WHEN OTHERS THEN
    -- Never block a signup or a confirmation over team membership; ops can
    -- still add the member by hand.
    RAISE WARNING 'join_byra_teams_on_confirmed_email: user %: % (%)',
      NEW.id, SQLERRM, SQLSTATE;
  END;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.join_byra_teams_on_confirmed_email() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_byra_teams_on_confirmed_email() FROM anon;

CREATE TRIGGER on_auth_user_created_join_byra_teams
  AFTER INSERT ON auth.users
  FOR EACH ROW
  WHEN (NEW.email_confirmed_at IS NOT NULL AND NEW.email IS NOT NULL)
  EXECUTE FUNCTION public.join_byra_teams_on_confirmed_email();

CREATE TRIGGER on_auth_user_confirmed_join_byra_teams
  AFTER UPDATE OF email_confirmed_at, email ON auth.users
  FOR EACH ROW
  WHEN (
    NEW.email_confirmed_at IS NOT NULL
    AND NEW.email IS NOT NULL
    AND (OLD.email_confirmed_at IS NULL OR NEW.email IS DISTINCT FROM OLD.email)
  )
  EXECUTE FUNCTION public.join_byra_teams_on_confirmed_email();

-- =============================================================================
-- 3b. brand_signup_allowlist: a role given to an existing account joins it
-- =============================================================================

CREATE OR REPLACE FUNCTION public.join_byra_team_on_allowlist_role()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  FOR v_user_id IN
    SELECT u.id
    FROM auth.users u
    WHERE lower(u.email) = NEW.email
      AND u.email_confirmed_at IS NOT NULL
  LOOP
    PERFORM public.join_byra_teams_for_user(v_user_id);
  END LOOP;
  RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.join_byra_team_on_allowlist_role() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_byra_team_on_allowlist_role() FROM anon;

CREATE TRIGGER brand_signup_allowlist_join_team
  AFTER INSERT OR UPDATE OF team_role ON public.brand_signup_allowlist
  FOR EACH ROW
  WHEN (NEW.team_role IS NOT NULL)
  EXECUTE FUNCTION public.join_byra_team_on_allowlist_role();

-- =============================================================================
-- 4. The cockpit cannot set team_role
-- =============================================================================

-- Same check as 20260827120000, plus team_role IS NULL. There is no UPDATE
-- policy, so an authenticated session cannot set the column afterwards either.
DROP POLICY IF EXISTS "brand_signup_allowlist_insert" ON public.brand_signup_allowlist;

CREATE POLICY "brand_signup_allowlist_insert" ON public.brand_signup_allowlist
  FOR INSERT WITH CHECK (
    team_role IS NULL
    AND EXISTS (
      SELECT 1
      FROM public.brands b
      JOIN public.team_members tm ON tm.team_id = b.team_id
      WHERE b.id = brand_id
        AND tm.user_id = auth.uid()
        AND tm.role IN ('owner', 'admin')
    )
  );

-- =============================================================================
-- 5. Backfill: the white-label setup's owner rows
-- =============================================================================

-- After the triggers, so an owner who already confirmed but was never added
-- joins now (the update is the same rule applied once to the rows that
-- predate it).
UPDATE public.brand_signup_allowlist
SET team_role = 'owner'
WHERE note = 'Byrå owner'
  AND team_role IS NULL;

NOTIFY pgrst, 'reload schema';
