-- Migration: byrå team members limited to chosen client companies
--
-- Joining a byrå team used to mean every client company: the INSERT sync
-- trigger added the new member to each one, and sync_team_to_company added
-- every member to each new client. A byrå owner could not let a colleague
-- reach only their own clients.
--
-- company_members stays the only access boundary (RLS via user_company_ids(),
-- the byrå cockpit, API keys and MCP all read it). This migration only decides
-- which rows the team sync writes:
--
--   1. team_members.all_companies, default true, so every existing member keeps
--      today's behaviour. false means only the client companies granted
--      explicitly, and no new clients automatically.
--   2. Owners and admins always have every company: promotion sets the flag,
--      a CHECK keeps the invariant.
--   3. team_invitations.company_ids: the companies a member invitation grants;
--      NULL means all.
--   4. The sync paths (member joins, new client company, flag turned back on)
--      only write rows for all-company members.
--   5. set_team_member_companies(): replaces a member's chosen companies in one
--      transaction. service_role only; the team routes authorize the caller.
--
-- pg-test: tests/pg/team-member-company-access.pg.test.ts

-- =============================================================================
-- 1. team_members.all_companies
-- =============================================================================

ALTER TABLE public.team_members
  ADD COLUMN all_companies boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN public.team_members.all_companies IS
  'true: the member reaches every client company of the team, including new '
  'ones (team sync). false: only the companies granted through '
  'set_team_member_companies(). Always true for owners and admins.';

-- =============================================================================
-- 2. Owners and admins always have every company
-- =============================================================================

ALTER TABLE public.team_members
  ADD CONSTRAINT team_members_managers_all_companies
  CHECK (all_companies OR role = 'member');

-- Promotion out of 'member' turns the flag on, so a role change never trips
-- the CHECK; the AFTER UPDATE sync below then adds the missing companies.
CREATE OR REPLACE FUNCTION public.team_member_managers_all_companies()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.role IN ('owner', 'admin') THEN
    NEW.all_companies := true;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER team_member_managers_all_companies
  BEFORE UPDATE OF role ON public.team_members
  FOR EACH ROW
  EXECUTE FUNCTION public.team_member_managers_all_companies();

-- =============================================================================
-- 3. team_invitations.company_ids
-- =============================================================================

ALTER TABLE public.team_invitations
  ADD COLUMN company_ids uuid[];

ALTER TABLE public.team_invitations
  ADD CONSTRAINT team_invitations_company_ids_member_only
  CHECK (company_ids IS NULL OR (role = 'member' AND cardinality(company_ids) > 0));

COMMENT ON COLUMN public.team_invitations.company_ids IS
  'Client companies a member invitation grants on acceptance. NULL: every '
  'company of the team, including new ones.';

-- =============================================================================
-- 4. Team sync writes rows only for all-company members
-- =============================================================================

CREATE OR REPLACE FUNCTION public.sync_team_member_to_companies()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_company_role text;
BEGIN
  -- A member limited to chosen companies gets them from
  -- set_team_member_companies(), never from the team as a whole.
  IF NOT NEW.all_companies THEN
    RETURN NEW;
  END IF;

  v_company_role := CASE
    WHEN NEW.role IN ('owner', 'admin') THEN 'admin'
    ELSE 'member'
  END;

  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT company.id, NEW.user_id, v_company_role, 'team'
  FROM public.companies company
  WHERE company.team_id = NEW.team_id
    AND company.archived_at IS NULL
  ON CONFLICT (company_id, user_id) DO NOTHING;

  RETURN NEW;
END;
$$;

-- Turning the flag back on (set_team_member_companies(..., NULL) or a
-- promotion) adds every company the member was missing. The trigger is not
-- "UPDATE OF all_companies": the promotion trigger above sets the column
-- without it appearing in the statement's SET list.
CREATE TRIGGER team_member_sync_all_companies
  AFTER UPDATE ON public.team_members
  FOR EACH ROW
  WHEN (NEW.all_companies AND NOT OLD.all_companies)
  EXECUTE FUNCTION public.sync_team_member_to_companies();

CREATE OR REPLACE FUNCTION public.sync_team_to_company(
  p_company_id uuid,
  p_team_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT p_company_id, tm.user_id,
    CASE
      WHEN tm.role IN ('owner', 'admin') THEN 'admin'
      ELSE 'member'
    END,
    'team'
  FROM public.team_members tm
  WHERE tm.team_id = p_team_id
    AND tm.all_companies
  ON CONFLICT (company_id, user_id) DO NOTHING;
END;
$$;

-- =============================================================================
-- 5. set_team_member_companies()
-- =============================================================================

CREATE OR REPLACE FUNCTION public.set_team_member_companies(
  p_team_member_id uuid,
  p_company_ids uuid[]
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_member public.team_members%ROWTYPE;
BEGIN
  SELECT * INTO v_member
  FROM public.team_members
  WHERE id = p_team_member_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'set_team_member_companies: team member not found'
      USING ERRCODE = 'P0002';
  END IF;

  -- NULL: every company again. The AFTER UPDATE sync adds the missing rows.
  IF p_company_ids IS NULL THEN
    UPDATE public.team_members SET all_companies = true
    WHERE id = v_member.id AND NOT all_companies;
    RETURN;
  END IF;

  IF v_member.role <> 'member' THEN
    RAISE EXCEPTION 'set_team_member_companies: owners and admins have every company'
      USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM unnest(p_company_ids) AS chosen(id)
    WHERE NOT EXISTS (
      SELECT 1 FROM public.companies c
      WHERE c.id = chosen.id
        AND c.team_id = v_member.team_id
        AND c.archived_at IS NULL
    )
  ) THEN
    RAISE EXCEPTION 'set_team_member_companies: company is not a client of this team'
      USING ERRCODE = '22023';
  END IF;

  UPDATE public.team_members SET all_companies = false
  WHERE id = v_member.id AND all_companies;

  -- Only team-sourced rows move. A membership someone added directly on a
  -- company (source = 'direct', the company owner among them) stays.
  DELETE FROM public.company_members cm
  WHERE cm.user_id = v_member.user_id
    AND cm.source = 'team'
    AND cm.company_id <> ALL (p_company_ids)
    AND cm.company_id IN (
      SELECT c.id FROM public.companies c
      WHERE c.team_id = v_member.team_id
        AND c.archived_at IS NULL
    );

  INSERT INTO public.company_members (company_id, user_id, role, source)
  SELECT DISTINCT chosen.id, v_member.user_id, 'member', 'team'
  FROM unnest(p_company_ids) AS chosen(id)
  ON CONFLICT (company_id, user_id) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_team_member_companies(uuid, uuid[])
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_team_member_companies(uuid, uuid[]) TO service_role;

COMMENT ON FUNCTION public.set_team_member_companies(uuid, uuid[]) IS
  'Sets which client companies a byrå team member reaches: NULL for every '
  'company (including new ones), else exactly the given team companies. Only '
  'team-sourced company_members rows change. No authorization check of its '
  'own: called by the team routes (which check the caller is team owner or '
  'admin) on the service role. Not callable by anon or authenticated.';

NOTIFY pgrst, 'reload schema';
