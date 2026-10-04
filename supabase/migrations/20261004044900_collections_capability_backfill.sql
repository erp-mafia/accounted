-- Backfill capability_grants for the new 'collections' capability: reminders,
-- debt collection and invoice delivery through a provider the company
-- activates itself (lib/collections).
--
-- collections joins PAID_CAPABILITIES but is PAID-PLAN ONLY: it is never part
-- of a trial. seed_trial_capability_grants() is deliberately left untouched
-- (its VALUES list matches TRIAL_CAPABILITIES in lib/entitlements/keys.ts, not
-- PAID_CAPABILITIES), and this backfill mirrors only the paid and operator
-- sources of each existing email_send grant:
--   stripe  the subscription sync (lib/stripe/subscription-sync.ts), which
--           writes every PAID key on the next subscription event anyway;
--   manual  operator grants, byrå team agreements included (team-scoped rows
--           keep their team_id);
--   comp    complimentary operator grants.
-- Trial rows are skipped. Connector rows are skipped too: on a self-host the
-- hourly connector sync writes source = 'connector' rows from the key's
-- scopes, and hosted holds none.
--
-- A grant switches nothing on by itself: every start path also needs
-- COLLECTIONS_ENABLED, the pilot list and an activated connection
-- (lib/collections/flags.ts), and no obligation path ever reads the grant.
--
-- pg-test: covered-by tests/pg/capability-collections-seed.pg.test.ts

insert into public.capability_grants
  (company_id, team_id, capability_key, source, granted_at, expires_at, metadata)
select
  g.company_id,
  g.team_id,
  'collections',
  g.source,
  g.granted_at,
  g.expires_at,
  jsonb_build_object(
    'backfilled_from', 'email_send',
    'backfill_migration', '20261004044900'
  )
from public.capability_grants g
where g.capability_key = 'email_send'
  and g.source in ('stripe', 'manual', 'comp')
on conflict (company_id, team_id, capability_key, source) do nothing;
