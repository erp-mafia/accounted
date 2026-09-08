-- Backfill capability_grants for the new 'zettle_sync' capability.
--
-- zettle_sync joins PAID_CAPABILITIES; existing companies' grants were written
-- before this key existed. Mirror each existing bank_sync grant (same sibling
-- used by stripe_payments / woocommerce_sync / shopify_sync backfills).

insert into public.capability_grants
  (company_id, team_id, capability_key, source, granted_at, expires_at, metadata)
select
  g.company_id,
  g.team_id,
  'zettle_sync',
  g.source,
  g.granted_at,
  g.expires_at,
  jsonb_build_object(
    'backfilled_from', 'bank_sync',
    'backfill_migration', '20260908120100'
  )
from public.capability_grants g
where g.capability_key = 'bank_sync'
on conflict (company_id, team_id, capability_key, source) do nothing;
