-- webhook_deliveries.outbox_id: the idempotency key of the webhook fan-out
-- delivered from the event outbox (step E3).
--
-- The outbox delivers at least once: a dispatcher that crashes after the
-- fan-out but before it marks the delivery done, or whose lease runs out
-- mid-cycle, leaves the delivery to be claimed and run again. The fan-out
-- (lib/webhooks/handler.ts) then writes with the event's outbox id and
-- inserts or ignores on (webhook_id, outbox_id), so a second run adds no row
-- for a webhook that already has one: the receiver is not sent the same event
-- twice under two delivery ids.
--
-- Nullable, no default: every row written inline (before the switch, the
-- webhook test and retry endpoints, an inline fallback) keeps NULL, and NULLs
-- are distinct in a unique index, so those rows are untouched by the key. No
-- foreign key to event_outbox: the outbox is pruned after 7 days and the
-- delivery log is kept (block_webhook_delivery_terminal_delete); the column is
-- a correlation, not an ownership.
--
-- A full unique index rather than a partial one: PostgREST's upsert names the
-- conflict columns only (ON CONFLICT (webhook_id, outbox_id)), which cannot
-- infer a partial index.
--
-- pg-test: tests/pg/event-outbox-async.pg.test.ts

-- webhook_deliveries is written by every webhook fan-out: fail the migration
-- job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.webhook_deliveries
  ADD COLUMN IF NOT EXISTS outbox_id bigint;

COMMENT ON COLUMN public.webhook_deliveries.outbox_id IS
  'event_outbox.id of the event when the fan-out ran from the event outbox (EVENT_DELIVERY_WEBHOOKS=outbox); NULL for a row written inline. Unique per webhook: a rerun of the same outbox delivery inserts nothing.';

CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_webhook_outbox_key
  ON public.webhook_deliveries (webhook_id, outbox_id);

NOTIFY pgrst, 'reload schema';
