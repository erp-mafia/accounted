-- Migration: teams.kind + deterministic personal-team attachment
--
-- White-label foundation slice (WL-08 resolution, dev_docs/white-label/):
-- teams get a kind ('personal' | 'byra') so byrå teams (named, multi-member,
-- brand-carrying) are distinguishable from the silent one-per-user "Personal"
-- shells. Byrå teams are created ops-assisted; every existing row becomes
-- 'personal' via the column default, and ops flips real byrå teams via the
-- service role.
--
-- Four changes:
--   1. teams.kind column with CHECK ('personal' | 'byra'), default 'personal'
--   2. ensure_user_team() now selects the user's PERSONAL team
--      deterministically (the old bare LIMIT 1 with no ORDER BY could hand a
--      consultant's new private company to the byrå team)
--   3. AFTER UPDATE OF role trigger on team_members re-syncs team-sourced
--      company_members roles (previously a demoted consultant kept admin in
--      every client book until they left the team)
--   4. Team rename path: explicit owner/admin UPDATE policy on teams, plus a
--      BEFORE UPDATE guard that makes kind changes ops-only

-- =============================================================================
-- 1. teams.kind
-- =============================================================================

ALTER TABLE public.teams
  ADD COLUMN kind text NOT NULL DEFAULT 'personal';

ALTER TABLE public.teams
  ADD CONSTRAINT teams_kind_check CHECK (kind IN ('personal', 'byra'));

COMMENT ON COLUMN public.teams.kind IS
  'personal = the silent one-per-user shell every user gets; byra = a named, '
  'multi-member accounting-firm team (invitable, brand-carrying, cockpit). '
  'Ops-managed: only the service role may change it after creation.';

-- =============================================================================
-- 2. Deterministic ensure_user_team()
-- =============================================================================
-- Replaces the definition from 20260415000000_schema_sync.sql. The old body
-- picked the user's first team_members row with a bare LIMIT 1 and no ORDER
-- BY, so under multi-team membership (own personal team + byrå team) a new
-- personal-flow company could arbitrarily attach to the byrå team, granting
-- the whole byrå admin access to the user's private books. Companies created
-- through the normal flow must always attach to the PERSONAL team; cockpit
-- flows pass the byrå team id explicitly (WL-08).
-- SECURITY DEFINER + search_path kept exactly as the original.

CREATE OR REPLACE FUNCTION public.ensure_user_team()
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_user_id uuid;
  v_team_id uuid;
BEGIN
  v_user_id := auth.uid();
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  -- Deterministic: only ever the user's personal team. ORDER BY is a
  -- tie-break for the (unexpected) case of multiple personal teams.
  SELECT tm.team_id INTO v_team_id
  FROM public.team_members tm
  JOIN public.teams t ON t.id = tm.team_id
  WHERE tm.user_id = v_user_id
    AND t.kind = 'personal'
  ORDER BY t.created_at, t.id
  LIMIT 1;

  IF v_team_id IS NOT NULL THEN
    RETURN v_team_id;
  END IF;

  INSERT INTO public.teams (name, created_by, kind)
  VALUES ('Personal', v_user_id, 'personal')
  RETURNING id INTO v_team_id;

  INSERT INTO public.team_members (team_id, user_id, role)
  VALUES (v_team_id, v_user_id, 'owner');

  RETURN v_team_id;
END;
$function$;

-- =============================================================================
-- 3. Role re-sync on team_members role UPDATE
-- =============================================================================
-- The INSERT sync (20260331010000, sync_team_member_to_companies) maps team
-- owner/admin to company admin and everything else to member, but nothing
-- re-synced on a role UPDATE: promoting a member did not grant admin, and
-- (worse) demoting an admin left them admin in every client company. This
-- trigger applies the same mapping to existing team-sourced rows. Rows with
-- source = 'direct' are never touched.

CREATE OR REPLACE FUNCTION public.resync_team_member_role_to_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_role text;
BEGIN
  -- Same mapping as sync_team_member_to_companies: team owner/admin becomes
  -- company admin, else member. Company 'owner' stays reserved for whoever
  -- created that specific company, so this can never mint a company owner.
  v_company_role := CASE
    WHEN NEW.role IN ('owner', 'admin') THEN 'admin'
    ELSE 'member'
  END;

  UPDATE public.company_members cm
  SET role = v_company_role
  WHERE cm.user_id = NEW.user_id
    AND cm.source = 'team'
    AND cm.role IS DISTINCT FROM v_company_role
    AND cm.company_id IN (
      SELECT c.id
      FROM public.companies c
      WHERE c.team_id = NEW.team_id
    );

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS team_member_sync_role_update ON public.team_members;

CREATE TRIGGER team_member_sync_role_update
  AFTER UPDATE OF role ON public.team_members
  FOR EACH ROW
  WHEN (OLD.role IS DISTINCT FROM NEW.role)
  EXECUTE FUNCTION public.resync_team_member_role_to_companies();

-- The company_members BEFORE UPDATE guard (20260422120000) blocks role
-- changes unless the caller is a company owner. The re-sync cascade above is
-- driven by an authorized team_members write (team admins, per team_members
-- RLS), typically by a caller who is only company *admin* in the client
-- companies, so the guard must let trigger-cascaded writes through.
-- pg_trigger_depth() > 1 identifies exactly those: a direct UPDATE of
-- company_members runs this guard at depth 1; a write issued from inside
-- another trigger (the re-sync) runs it at depth 2. Users cannot create
-- triggers, and the team-to-company mapping never produces 'owner', so the
-- passthrough cannot be used to mint or demote company owners.

CREATE OR REPLACE FUNCTION public.enforce_company_member_role_transitions()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  caller_role text;
BEGIN
  -- Service role, SECURITY DEFINER cascades, and direct SQL have no auth context.
  IF auth.uid() IS NULL THEN
    RETURN NEW;
  END IF;

  -- Trigger-cascaded writes come from our own sync triggers
  -- (team_member_sync_role_update), not from a direct user statement.
  IF pg_trigger_depth() > 1 THEN
    RETURN NEW;
  END IF;

  -- Nothing to enforce if the role field isn't changing.
  IF NEW.role IS NOT DISTINCT FROM OLD.role THEN
    RETURN NEW;
  END IF;

  caller_role := public.user_role_in_company(OLD.company_id);

  IF caller_role IS DISTINCT FROM 'owner' THEN
    RAISE EXCEPTION
      'Only owners can change member roles (your role: %)',
      COALESCE(caller_role, 'none');
  END IF;

  RETURN NEW;
END;
$$;

-- =============================================================================
-- 4. Team rename path
-- =============================================================================
-- Recreate the UPDATE policy so the rename grant (team owner/admin) is
-- explicit next to the kind guard. Behavior is identical to 20260422120000:
-- user_is_team_admin() already includes the created_by fallback internally.

DROP POLICY IF EXISTS "teams_update" ON public.teams;

CREATE POLICY "teams_update" ON public.teams
  FOR UPDATE
  USING (public.user_is_team_admin(id))
  WITH CHECK (public.user_is_team_admin(id));

-- Rename is allowed; kind changes are ops-only. Follows the codebase guard
-- convention (enforce_company_member_role_transitions): auth.uid() IS NULL
-- means service role, SECURITY DEFINER cascade, or direct SQL, all trusted
-- ops paths; any user session is rejected.

CREATE OR REPLACE FUNCTION public.enforce_team_kind_ops_only()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.kind IS DISTINCT FROM OLD.kind AND auth.uid() IS NOT NULL THEN
    RAISE EXCEPTION
      'teams.kind is ops-managed; rename is allowed but kind changes require the service role'
      USING ERRCODE = '42501';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_team_kind_ops_only ON public.teams;

CREATE TRIGGER enforce_team_kind_ops_only
  BEFORE UPDATE ON public.teams
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_team_kind_ops_only();

NOTIFY pgrst, 'reload schema';
