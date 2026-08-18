-- Trial seeding must grant every PAID capability, not the 2026-06-29 four.
--
-- lib/entitlements/keys.ts PAID_CAPABILITIES grew to seven keys
-- (stripe_payments 2026-07-12, woocommerce_sync 2026-08-06, shopify_sync
-- 2026-08-08). The Stripe webhook writes grants from that constant, so
-- payers have all seven; the trial trigger seed_trial_capability_grants()
-- (20260629120000) still hardcodes ('ai','bank_sync','skatteverket',
-- 'email_send'), and each key's backfill only mirrored the grants that
-- existed on its day. Every company created since is trialing without the
-- newer keys: on 2026-08-18, 226 of 230 active trialers lacked
-- stripe_payments, 146 woocommerce_sync, 131 shopify_sync.
--
-- 1. Redefine the trigger function with the full PAID set. Keep this VALUES
--    list in step with PAID_CAPABILITIES whenever a key is added (and add a
--    backfill like part 2 for the companies already seeded).
-- 2. Backfill: mirror every existing trial bank_sync grant (same company,
--    same expiry) for the three missing keys. Idempotent via the unique
--    index; expired trials are mirrored too so state stays aligned, exactly
--    as the earlier backfills did.

CREATE OR REPLACE FUNCTION public.seed_trial_capability_grants()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.capability_grants (company_id, capability_key, source, expires_at)
  SELECT NEW.id, k.key, 'trial', NEW.created_at + interval '30 days'
  FROM (VALUES
    ('ai'),
    ('bank_sync'),
    ('skatteverket'),
    ('email_send'),
    ('stripe_payments'),
    ('woocommerce_sync'),
    ('shopify_sync')
  ) AS k(key)
  ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
  RETURN NEW;
END;
$$;

INSERT INTO public.capability_grants
  (company_id, team_id, capability_key, source, granted_at, expires_at, metadata)
SELECT
  g.company_id,
  g.team_id,
  k.key,
  g.source,
  g.granted_at,
  g.expires_at,
  jsonb_build_object(
    'backfilled_from', 'bank_sync',
    'backfill_migration', '20260818170000'
  )
FROM public.capability_grants g
CROSS JOIN (VALUES ('stripe_payments'), ('woocommerce_sync'), ('shopify_sync')) AS k(key)
WHERE g.capability_key = 'bank_sync' AND g.source = 'trial'
ON CONFLICT (company_id, team_id, capability_key, source) DO NOTHING;
