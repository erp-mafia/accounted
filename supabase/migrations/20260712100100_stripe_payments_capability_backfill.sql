-- Backfill capability_grants for the new 'stripe_payments' capability.
--
-- stripe_payments joins PAID_CAPABILITIES, but existing companies' grants were
-- written by the billing webhook / trial seeding BEFORE this key existed, and
-- are only refreshed on the next subscription event. Without a backfill, every
-- current payer and trialer would see the Stripe integration as not entitled
-- until their next webhook. Mirror each existing bank_sync grant (the closest
-- sibling capability: same paid tier, same sources) with identical scope,
-- source and expiry, so entitlement state stays exactly aligned.
--
-- Idempotent: the (scope, key, source) unique index makes re-runs no-ops.

insert into public.capability_grants
  (company_id, team_id, capability_key, source, granted_at, expires_at, metadata)
select
  g.company_id,
  g.team_id,
  'stripe_payments',
  g.source,
  g.granted_at,
  g.expires_at,
  jsonb_build_object(
    'backfilled_from', 'bank_sync',
    'backfill_migration', '20260712100100'
  )
from public.capability_grants g
where g.capability_key = 'bank_sync'
on conflict (company_id, team_id, capability_key, source) do nothing;
