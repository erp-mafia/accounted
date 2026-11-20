-- The capability gate read capability_grants through the caller's client, so
-- the SELECT policy (company rows for members, team rows for TEAM members only)
-- hid a byrå team's grant from a client company's own users: the company was
-- entitled on paper and gated in practice. company_has_capability already
-- resolves the team cascade under SECURITY DEFINER, but the TS gate needs the
-- rows themselves (source, team_id, expires_at) for the trial state, coverage
-- and the self-host connector-only rule. This returns exactly those rows for
-- one company, narrowed the way the direct read was (key list, and on a
-- self-host only source = 'connector'), behind the same tenant guard.

CREATE OR REPLACE FUNCTION public.company_capability_grant_rows(
  p_company_id      uuid,
  p_capability_keys text[],
  p_connector_only  boolean DEFAULT false
)
RETURNS TABLE (
  capability_key text,
  expires_at     timestamptz,
  source         text,
  team_id        uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_jwt_role text := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  v_team_id  uuid;
BEGIN
  -- Same tenant guard as company_has_capability: anon/authenticated may only
  -- ask about their own companies; service_role and direct access bypass by
  -- design, with company scoping enforced in TS.
  IF v_jwt_role IN ('anon', 'authenticated')
     AND NOT public.caller_is_company_member(p_company_id) THEN
    RAISE EXCEPTION 'unauthorized: caller is not a member of company %', p_company_id
      USING ERRCODE = '42501';
  END IF;

  SELECT c.team_id INTO v_team_id FROM public.companies c WHERE c.id = p_company_id;

  RETURN QUERY
    SELECT g.capability_key::text, g.expires_at, g.source::text, g.team_id
    FROM public.capability_grants g
    WHERE (
            g.company_id = p_company_id
            OR (v_team_id IS NOT NULL AND g.team_id = v_team_id)
          )
      AND g.capability_key = ANY (p_capability_keys)
      AND (NOT p_connector_only OR g.source = 'connector');
END;
$$;

REVOKE ALL ON FUNCTION public.company_capability_grant_rows(uuid, text[], boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_capability_grant_rows(uuid, text[], boolean) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';
