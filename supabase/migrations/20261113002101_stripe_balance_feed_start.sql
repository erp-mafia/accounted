-- The Stripe balance feed reads in bounded windows and can pause a backfill
-- partway (accounted#209). Its cursor is then still before the connection
-- moment, which made every later run a first run again: it re-read about a
-- month of the open Stripe balance before the cursor, re-ran the 1686 chart
-- setup, and could stop for good when that month held more than one run
-- reads. The feed records the start it has read the open balance of, so a
-- paused backfill resumes from its cursor like any later run.
--
-- Nullable, no backfill: NULL means the connection moment (connected_at),
-- which is what every existing row's feed started from. Table-level grants
-- and the existing RLS policies cover the new column.

alter table public.stripe_connections
  add column balance_txn_feed_start timestamptz;

comment on column public.stripe_connections.balance_txn_feed_start is
  'Feed start (a connection moment or backfill day) whose open Stripe balance the balance-transaction feed has read. A cursor at or before it starts a first run; a later cursor resumes with the 24h overlap. NULL: connected_at.';

NOTIFY pgrst, 'reload schema';
