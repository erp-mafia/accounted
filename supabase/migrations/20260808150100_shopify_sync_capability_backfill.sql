-- Backfill capability_grants for the new 'shopify_sync' capability.
--
-- shopify_sync joins PAID_CAPABILITIES, but existing companies' grants were
-- written by the billing webhook / trial seeding BEFORE this key existed, and
-- are only refreshed on the next subscription event. Without a backfill,
-- every current payer and trialer would see the Shopify integration as not
-- entitled until their next webhook. Mirror each existing bank_sync grant
-- (the same sibling used by the stripe_payments and woocommerce_sync
-- backfills, 20260712100100 / 20260806170100) with identical scope, source
-- and expiry, so entitlement state stays exactly aligned.
--
-- Idempotent: the (scope, key, source) unique index makes re-runs no-ops.

insert into public.capability_grants
  (company_id, team_id, capability_key, source, granted_at, expires_at, metadata)
select
  g.company_id,
  g.team_id,
  'shopify_sync',
  g.source,
  g.granted_at,
  g.expires_at,
  jsonb_build_object(
    'backfilled_from', 'bank_sync',
    'backfill_migration', '20260808150100'
  )
from public.capability_grants g
where g.capability_key = 'bank_sync'
on conflict (company_id, team_id, capability_key, source) do nothing;
