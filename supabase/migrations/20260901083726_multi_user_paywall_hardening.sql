-- Multi-user paywall hardening (skeptic findings on 20260901081417):
--
-- 1. company_multi_user_state(): state-returning SECURITY DEFINER twin of
--    company_multi_user_ok. The capability_grants SELECT policy hides
--    team-scoped rows from users who are not on the team (byrå clients by
--    design, WL-08), so any app-side read through a user-scoped client
--    misreads a team-covered company as frozen. All app-side state checks go
--    through this function first; the raw grants read stays only as the
--    fallback for not-yet-migrated databases.
-- 2. Byrå teams get a standing team-scoped multi_user grant (backfill +
--    trigger): the codebase's WL-10 assumption is that byrå client companies
--    are entitled via the team agreement (their company-scoped trial is
--    deliberately suppressed), so a byrå team without grant rows would
--    freeze every consultant and client user. Billing for byrå partners is
--    out-of-band (partner agreement), matching seed_trial_capability_grants'
--    suppression rationale.
-- 3. Comped/manual companies (active company-scoped comp/manual grants on
--    the pre-existing PAID keys) extend to multi_user: a hand-comped
--    multi-member company must not read as paying while locking out its
--    second user.

-- ============================================================================
-- 1. company_multi_user_state(company, grace_days)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.company_multi_user_state(p_company_id uuid, p_grace_days integer)
  RETURNS TABLE(state text, grace_ends_at timestamptz)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  WITH grant_rows AS (
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
      WHEN a.entitled THEN 'entitled'
      WHEN a.newest_expiry IS NOT NULL
       AND a.newest_expiry + make_interval(days => GREATEST(p_grace_days, 0)) > now() THEN 'grace'
      ELSE 'frozen'
    END AS state,
    CASE
      WHEN NOT a.entitled
       AND a.newest_expiry IS NOT NULL
       AND a.newest_expiry + make_interval(days => GREATEST(p_grace_days, 0)) > now()
      THEN a.newest_expiry + make_interval(days => GREATEST(p_grace_days, 0))
      ELSE NULL
    END AS grace_ends_at
  FROM agg a;
$function$;

REVOKE ALL ON FUNCTION public.company_multi_user_state(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_multi_user_state(uuid, integer) TO authenticated, service_role;

-- ============================================================================
-- 2. Byrå team standing grant: backfill + trigger for future teams
-- ============================================================================
INSERT INTO public.capability_grants (team_id, capability_key, source, expires_at, metadata)
SELECT t.id, 'multi_user', 'manual', NULL,
       jsonb_build_object('reason', 'byra_team_default')
FROM public.teams t
WHERE t.kind = 'byra'
  AND NOT EXISTS (
    SELECT 1 FROM public.capability_grants g
    WHERE g.team_id = t.id
      AND g.capability_key = 'multi_user'
      AND (g.expires_at IS NULL OR g.expires_at > now())
  )
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;

CREATE OR REPLACE FUNCTION public.seed_byra_team_multi_user()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NEW.kind = 'byra' THEN
    INSERT INTO public.capability_grants (team_id, capability_key, source, expires_at, metadata)
    VALUES (NEW.id, 'multi_user', 'manual', NULL, jsonb_build_object('reason', 'byra_team_default'))
    ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_seed_byra_team_multi_user ON public.teams;
CREATE TRIGGER trg_seed_byra_team_multi_user
  AFTER INSERT OR UPDATE OF kind ON public.teams
  FOR EACH ROW EXECUTE FUNCTION public.seed_byra_team_multi_user();

-- ============================================================================
-- 3. Comped/manual companies extend to multi_user
-- ============================================================================
INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at, metadata)
SELECT cg.company_id, 'multi_user', 'comp',
       CASE WHEN bool_or(cg.expires_at IS NULL) THEN NULL ELSE max(cg.expires_at) END,
       jsonb_build_object('backfill', 'multi_user_launch_comp')
FROM public.capability_grants cg
WHERE cg.company_id IS NOT NULL
  AND cg.source IN ('comp', 'manual')
  AND cg.capability_key IN
    ('ai', 'bank_sync', 'skatteverket', 'email_send', 'stripe_payments', 'woocommerce_sync', 'shopify_sync')
GROUP BY cg.company_id
HAVING bool_or(cg.expires_at IS NULL OR cg.expires_at > now())
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;

NOTIFY pgrst, 'reload schema';
