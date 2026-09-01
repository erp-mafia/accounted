-- Multi-user paywall: the `multi_user` capability (founder decision 2026-09-01).
--
-- Multiple people working in one company becomes a PAID capability. The rule
-- (lib/entitlements/multi-user-state.ts is the TS twin; keep them aligned):
--
--   entitled : an active multi_user grant (trial/stripe/team/manual/comp).
--   grace    : the newest grant expired less than p_grace_days (20) ago.
--              Everyone still works; the app shows a countdown banner.
--   frozen   : lapsed >= 20 days ago (or never granted). Only role = 'owner'
--              memberships resolve; every other membership is dormant. Rows
--              are NEVER deleted: paying reactivates everyone instantly.
--
-- Enforcement is derived at resolution time (no status column, no cron):
-- resolve_active_company_gated() below is the gated twin of
-- resolve_active_company() (20260723161000). The zero-arg function and
-- current_active_company_id() are deliberately UNTOUCHED:
--   - they also run on self-hosted instances, where the seat gate must never
--     bite (multi_user is a local capability there; the app only calls the
--     gated function when lib/entitlements isMultiUserEnforced() is true);
--   - current_active_company_id() (RLS side) converges via the middleware
--     write-back: when the preference points at a frozen company the gated
--     function reports used_fallback = true, middleware persists the
--     accessible company to user_preferences, and RLS follows. During the
--     one-request window before the write-back the app never serves the
--     frozen company anyway (resolution is the only source of companyId).
--
-- Also in this migration:
--   - seed_trial_capability_grants() learns the eighth key ('multi_user').
--   - Backfills so existing companies land in the right state at deploy:
--     mid-trial -> trial grant, active Stripe subs -> stripe grant, teams
--     with active agreements -> team grant, and every other non-archived
--     company with more than one member -> a 'manual' grant expiring NOW,
--     which starts their 20-day grace window at deploy time (the
--     grandfather cohort; metadata.reason = 'multi_user_grandfather').

-- =============================================================================
-- 1. company_multi_user_ok(company, grace_days): entitled-or-in-grace check
-- =============================================================================
-- True while the company may have several active people: an unexpired
-- multi_user grant (company- or team-scoped), or one that expired less than
-- p_grace_days ago. Never granted => false. company_capability_config is
-- deliberately NOT consulted: a config disable has no expiry to hang the
-- grace window on, and member access must not freeze through a side channel.
CREATE OR REPLACE FUNCTION public.company_multi_user_ok(p_company_id uuid, p_grace_days integer)
  RETURNS boolean
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.capability_grants cg
    WHERE cg.capability_key = 'multi_user'
      AND (
        cg.company_id = p_company_id
        OR cg.team_id = (SELECT c.team_id FROM public.companies c WHERE c.id = p_company_id)
      )
      AND (
        cg.expires_at IS NULL
        OR cg.expires_at > now() - make_interval(days => GREATEST(p_grace_days, 0))
      )
  );
$function$;

REVOKE ALL ON FUNCTION public.company_multi_user_ok(uuid, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.company_multi_user_ok(uuid, integer) TO authenticated, service_role;

-- =============================================================================
-- 2. resolve_active_company_gated(grace_days): the seat-gated resolution
-- =============================================================================
-- Semantics of resolve_active_company() (20260723161000) with one added
-- predicate: a membership resolves only when the caller is the company's
-- owner or the company passes company_multi_user_ok(). Keep everything else
-- IDENTICAL to the zero-arg function (resolution order, NULL auth.uid()
-- behavior, no writes); see its header for the invariants.
--
-- has_locked_membership is computed only when nothing resolved: it tells the
-- caller "this user has companies, but every one of them is frozen for them"
-- so middleware can route to the paused page instead of onboarding.
CREATE OR REPLACE FUNCTION public.resolve_active_company_gated(p_grace_days integer)
  RETURNS TABLE(company_id uuid, locale text, used_fallback boolean, has_locked_membership boolean)
  LANGUAGE sql
  STABLE SECURITY DEFINER
  SET search_path TO 'public'
AS $function$
  WITH pref AS (
    SELECT up.active_company_id, up.locale
    FROM public.user_preferences up
    WHERE up.user_id = auth.uid()
  ),
  validated AS (
    SELECT cm.company_id
    FROM pref p
    JOIN public.company_members cm
      ON cm.user_id = auth.uid() AND cm.company_id = p.active_company_id
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.role = 'owner' OR public.company_multi_user_ok(cm.company_id, p_grace_days)
    LIMIT 1
  ),
  fallback AS (
    SELECT cm.company_id
    FROM public.company_members cm
    JOIN public.companies c
      ON c.id = cm.company_id AND c.archived_at IS NULL
    WHERE cm.user_id = auth.uid()
      AND (cm.role = 'owner' OR public.company_multi_user_ok(cm.company_id, p_grace_days))
    ORDER BY cm.created_at ASC
    LIMIT 1
  ),
  resolved AS (
    SELECT COALESCE(
      (SELECT v.company_id FROM validated v),
      (SELECT f.company_id FROM fallback f)
    ) AS company_id
  )
  SELECT
    (SELECT r.company_id FROM resolved r) AS company_id,
    (SELECT p.locale FROM pref p) AS locale,
    ((SELECT v.company_id FROM validated v) IS NULL) AS used_fallback,
    CASE
      WHEN (SELECT r.company_id FROM resolved r) IS NOT NULL THEN false
      ELSE EXISTS (
        SELECT 1
        FROM public.company_members cm
        JOIN public.companies c ON c.id = cm.company_id AND c.archived_at IS NULL
        WHERE cm.user_id = auth.uid()
          AND cm.role <> 'owner'
          AND NOT public.company_multi_user_ok(cm.company_id, p_grace_days)
      )
    END AS has_locked_membership
  WHERE auth.uid() IS NOT NULL;
$function$;

REVOKE ALL ON FUNCTION public.resolve_active_company_gated(integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_active_company_gated(integer) TO authenticated;

-- =============================================================================
-- 3. Trial seeding: the eighth key
-- =============================================================================
-- Replaces ONLY the function body (same shape as 20260826130300): the byrå
-- suppression stays, the VALUES list grows by 'multi_user'. Keep in step with
-- lib/entitlements/keys.ts PAID_CAPABILITIES.
CREATE OR REPLACE FUNCTION public.seed_trial_capability_grants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Byrå-team companies are covered by the team's agreement (WL-10):
  -- no company-scoped trial, so no trial-expiry noise toward byrå clients.
  IF NEW.team_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.teams t
    WHERE t.id = NEW.team_id
      AND t.kind = 'byra'
  ) THEN
    RETURN NEW;
  END IF;

  -- Full PAID set as of 20260901081417; keep this VALUES list in step with
  -- lib/entitlements/keys.ts PAID_CAPABILITIES whenever a key is added.
  INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
  SELECT NEW.id, k.key, 'trial', NEW.created_at + interval '30 days'
  FROM (VALUES
    ('ai'),
    ('bank_sync'),
    ('skatteverket'),
    ('email_send'),
    ('stripe_payments'),
    ('woocommerce_sync'),
    ('shopify_sync'),
    ('multi_user')
  ) AS k(key)
  ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
  RETURN NEW;
END;
$$;

-- =============================================================================
-- 4. Backfills (idempotent: ON CONFLICT DO NOTHING against the scope index)
-- =============================================================================

-- 4a. Every trial-seeded company gets a multi_user trial row matching its
-- trial expiry, expired trials included: "the trial always covered
-- multi_user". Mid-trial companies stay fully entitled; long-expired ones
-- read as frozen exactly like a never-granted company, and the recently
-- expired land in whatever grace their trial end implies (4d then guarantees
-- multi-member companies a full window from deploy).
INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
SELECT cg.company_id, 'multi_user', 'trial', max(cg.expires_at)
FROM public.capability_grants cg
WHERE cg.source = 'trial'
  AND cg.company_id IS NOT NULL
  AND cg.expires_at IS NOT NULL
GROUP BY cg.company_id
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;

-- 4b. Companies with a live Stripe subscription: same shape the webhook sync
-- writes (source = 'stripe', period end + 3 days slack; see
-- lib/stripe/subscription-sync.ts). The next webhook upserts over this.
INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at, metadata)
SELECT cs.company_id, 'multi_user', 'stripe',
       cs.current_period_end + interval '3 days',
       jsonb_build_object('backfill', 'multi_user_launch')
FROM public.company_subscriptions cs
WHERE cs.status IN ('active', 'trialing', 'past_due')
  AND cs.current_period_end IS NOT NULL
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;

-- 4c. Teams holding any active grant (byrå partner agreements) extend to
-- multi_user at team scope, so one paying byrå keeps covering all its client
-- companies. NULL expiry wins when any of the team's active grants never
-- expires.
INSERT INTO public.capability_grants (team_id, capability_key, source, expires_at, metadata)
SELECT cg.team_id, 'multi_user', 'manual',
       CASE WHEN bool_or(cg.expires_at IS NULL) THEN NULL ELSE max(cg.expires_at) END,
       jsonb_build_object('backfill', 'multi_user_launch')
FROM public.capability_grants cg
WHERE cg.team_id IS NOT NULL
GROUP BY cg.team_id
HAVING bool_or(cg.expires_at IS NULL OR cg.expires_at > now())
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;

-- 4d. Grandfather cohort: every remaining non-archived company with more
-- than one member gets a grant expiring NOW, which puts it in grace until
-- deploy + 20 days. Owners are mailed the freeze date out-of-band; the app
-- shows the countdown banner from the first render after deploy.
INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at, metadata)
SELECT c.id, 'multi_user', 'manual', now(),
       jsonb_build_object('reason', 'multi_user_grandfather')
FROM public.companies c
WHERE c.archived_at IS NULL
  AND (SELECT count(*) FROM public.company_members cm WHERE cm.company_id = c.id) > 1
  AND NOT EXISTS (
    SELECT 1 FROM public.capability_grants g
    WHERE g.capability_key = 'multi_user'
      AND (
        g.company_id = c.id
        OR (c.team_id IS NOT NULL AND g.team_id = c.team_id)
      )
      AND (g.expires_at IS NULL OR g.expires_at > now())
  )
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;

NOTIFY pgrst, 'reload schema';
