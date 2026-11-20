-- Validate the inline_result CHECK re-added in 20261018110000.
-- Separate transaction: avoids the scan under the stronger lock of the
-- preceding migration (same split as 20261016200100). VALIDATE CONSTRAINT
-- only reads the rows; nothing is rewritten.
-- pg-test: covered-by tests/pg/event-outbox-async.pg.test.ts

-- event_deliveries is written by every emit in shadow mode: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.event_deliveries
  VALIDATE CONSTRAINT event_deliveries_inline_result_check;
