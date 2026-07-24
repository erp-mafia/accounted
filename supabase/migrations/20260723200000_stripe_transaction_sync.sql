-- Stripe balance-transaction sync (the "Stripe balance as a bank feed" feature).
--
-- Balance transactions from the connected account land in the transactions
-- inbox as feed rows on a 1686 cash account (see
-- extensions/general/stripe/lib/transaction-sync.ts). Two new columns on
-- stripe_connections drive it:
--
--   - transaction_sync_enabled: per-connection opt-in. Off by default: a
--     company using only invoice payment links should not suddenly get a
--     second feed in its inbox.
--   - last_balance_txn_synced_at: polling cursor (max balance-transaction
--     `created` processed). The sync re-polls with a 24h overlap and relies on
--     the (company_id, external_id) unique index on transactions for
--     idempotency, mirroring last_event_created_at for the event sync.

alter table public.stripe_connections
  add column transaction_sync_enabled boolean not null default false,
  add column last_balance_txn_synced_at timestamptz;

comment on column public.stripe_connections.transaction_sync_enabled is
  'Opt-in: import the connected account''s balance transactions into the transactions inbox (Stripe balance as a bank feed).';
comment on column public.stripe_connections.last_balance_txn_synced_at is
  'Balance-transaction polling cursor (max created processed); the sync overlaps it by 24h and dedups on external_id.';

NOTIFY pgrst, 'reload schema';
