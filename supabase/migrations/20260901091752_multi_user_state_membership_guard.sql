-- Membership guard on the multi-user entitlement helpers (Superagent P3 on
-- PR #2099): both SECURITY DEFINER functions took a caller-supplied company
-- UUID and were granted to `authenticated`, so any logged-in user could probe
-- an arbitrary company's billing state (entitled/grace/frozen + deadline)
-- across tenants. Both now require the caller to be a member of the company
-- when a JWT is present; service-role/definer contexts (auth.uid() IS NULL)
-- keep unrestricted behavior for trusted server callers. The grace window is
-- also clamped to [0, 20] days so the parameter cannot widen the probe.
--
-- Non-member outcomes: company_multi_user_ok returns false;
-- company_multi_user_state returns its row with a NULL state (callers treat
-- only 'entitled'/'grace'/'frozen' as answers). Every legitimate caller
-- passes: the app only ever asks about companies the user is a member of,
-- and resolve_active_company_gated only evaluates the caller's own
-- membership rows.

CREATE OR REPLACE FUNCTION public.company_multi_user_ok(p_company_id uuid, p_grace_days integer)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT
    (
      auth.uid() IS NULL
      OR EXISTS (
        SELECT 1 FROM public.company_members cm
        WHERE cm.company_id = p_company_id AND cm.user_id = auth.uid()
      )
    )
    AND EXISTS (
      SELECT 1
      FROM public.capability_grants cg
      WHERE cg.capability_key = 'multi_user'
        AND (
          cg.company_id = p_company_id
          OR cg.team_id = (SELECT c.team_id FROM public.companies c WHERE c.id = p_company_id)
        )
        AND (
          cg.expires_at IS NULL
          OR cg.expires_at > now() - make_interval(days => LEAST(GREATEST(p_grace_days, 0), 20))
        )
    );
$function$;

CREATE OR REPLACE FUNCTION public.company_multi_user_state(p_company_id uuid, p_grace_days integer)
  RETURNS TABLE(state text, grace_ends_at timestamptz)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  WITH allowed AS (
    SELECT
      auth.uid() IS NULL
      OR EXISTS (
        SELECT 1 FROM public.company_members cm
        WHERE cm.company_id = p_company_id AND cm.user_id = auth.uid()
      ) AS ok
  ),
  grant_rows AS (
    SELECT cg.expires_at
    FROM public.capability_grants cg
    WHERE cg.capability_key = 'multi_user'
      AND (
        cg.company_id = p_company_id
        OR cg.team_id = (SELECT c.team_id FROM public.companies c WHERE c.id = p_company_id)
      )
  ),
  agg AS (
    SELECT
      COALESCE(bool_or(gr.expires_at IS NULL OR gr.expires_at > now()), false) AS entitled,
      max(gr.expires_at) AS newest_expiry
    FROM grant_rows gr
  )
  SELECT
    CASE
      WHEN NOT al.ok THEN NULL
      WHEN a.entitled THEN 'entitled'
      WHEN a.newest_expiry IS NOT NULL
       AND a.newest_expiry + make_interval(days => LEAST(GREATEST(p_grace_days, 0), 20)) > now() THEN 'grace'
      ELSE 'frozen'
    END AS state,
    CASE
      WHEN al.ok
       AND NOT a.entitled
       AND a.newest_expiry IS NOT NULL
       AND a.newest_expiry + make_interval(days => LEAST(GREATEST(p_grace_days, 0), 20)) > now()
      THEN a.newest_expiry + make_interval(days => LEAST(GREATEST(p_grace_days, 0), 20))
      ELSE NULL
    END AS grace_ends_at
  FROM agg a, allowed al;
$function$;

NOTIFY pgrst, 'reload schema';