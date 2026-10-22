-- Collections joins the trial (founder decision 2026-10-22, reversing the
-- paid-plan-only decision of 2026-10-04 and 20261012030000): a company in
-- its trial can activate its collections provider and hand invoices over
-- like a paying one. lib/entitlements/keys.ts PAID_PLAN_ONLY_CAPABILITIES is
-- now empty, so TRIAL_CAPABILITIES (which this VALUES list must match) gains
-- collections.
--
-- 1. seed_trial_capability_grants() from its latest body (20260909100300)
--    with collections added to the VALUES list; the byrå suppression and
--    everything else unchanged.
-- 2. Backfill for the trials already running: every company holding an
--    unexpired company-scoped trial grant for bank_sync (a key the trial has
--    always seeded) gets a collections trial grant with the SAME expiry, so
--    it ends with the rest of the trial. A company that already holds an
--    unexpired collections grant (its own or its team's, any source) gets
--    nothing; a lapsed trial gets nothing. Byrå clients never held a trial
--    grant (suppressed at creation), so they get nothing either.
--
-- A lapsed trial never strands a case: every obligation path (an open case,
-- an unbooked collected payment or payout) ignores the capability
-- (lib/collections/flags.ts). A grant switches nothing on by itself: every
-- start path also needs COLLECTIONS_ENABLED, the pilot list and the
-- company's own activation.
--
-- pg-test: covered-by tests/pg/capability-collections-seed.pg.test.ts

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

  -- Full PAID set as of 20261022120000; keep this VALUES list in step with
  -- lib/entitlements/keys.ts TRIAL_CAPABILITIES whenever a key is added.
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
    ('zettle_sync'),
    ('multi_user'),
    ('collections')
  ) AS k(key)
  ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
  RETURN NEW;
END;
$$;

INSERT INTO public.capability_grants
  (company_id, team_id, capability_key, source, granted_at, expires_at, metadata)
SELECT
  g.company_id,
  NULL,
  'collections',
  'trial',
  now(),
  g.expires_at,
  jsonb_build_object(
    'backfilled_from', 'bank_sync',
    'backfill_migration', '20261022120000'
  )
FROM public.capability_grants g
JOIN public.companies c ON c.id = g.company_id
WHERE g.capability_key = 'bank_sync'
  AND g.source = 'trial'
  AND g.team_id IS NULL
  AND (g.expires_at IS NULL OR g.expires_at > now())
  AND NOT EXISTS (
    SELECT 1 FROM public.capability_grants x
    WHERE x.capability_key = 'collections'
      AND (x.expires_at IS NULL OR x.expires_at > now())
      AND (x.company_id = g.company_id OR (c.team_id IS NOT NULL AND x.team_id = c.team_id))
  )
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
