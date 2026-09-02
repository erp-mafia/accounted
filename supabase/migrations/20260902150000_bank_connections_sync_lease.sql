-- Durable cooldown lease for the agent-triggered bank sync (v1
-- POST /bank-connections/{id}/sync and MCP gnubok_sync_bank).
--
-- The runner promises at most one paid Enable Banking round-trip per
-- connection per 15 minutes. last_synced_at only advances on success, and a
-- process-local attempt map does not survive a cold start or a second
-- serverless instance, so two concurrent agent calls (or retries of a
-- failing connection routed to fresh instances) could each bill the bank.
--
-- The claim is one conditional UPDATE: set sync_lease_until = now + 15 min
-- WHERE sync_lease_until <= now. Postgres row locking serialises concurrent
-- claimers, so exactly one wins; the rest read the held lease and answer
-- BANK_SYNC_COOLDOWN. Failures keep the lease (that is the throttle),
-- success is also covered by last_synced_at. The nightly cron ignores it.
--
-- NOT NULL with an epoch default so the claim is a single literal `<=`
-- filter (a NULL-or-past OR would have to be built at runtime, which the
-- schema guard cannot check): "never claimed" is simply "expired long ago".
ALTER TABLE public.bank_connections
  ADD COLUMN IF NOT EXISTS sync_lease_until timestamptz NOT NULL DEFAULT 'epoch';

COMMENT ON COLUMN public.bank_connections.sync_lease_until IS
  'Agent-triggered sync cooldown lease: no on-demand sync is accepted before this instant. Claimed atomically by extensions/general/enable-banking/lib/trigger-sync.ts; epoch means never claimed.';
