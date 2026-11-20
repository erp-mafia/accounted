-- Event outbox, step E3: a delivery the bus deferred to the outbox.
--
-- With EVENT_OUTBOX_MODE=shadow and a consumer's own switch on outbox
-- (EVENT_DELIVERY_WEBHOOKS=outbox for the webhooks consumer,
-- lib/events/consumer-index.ts), the bus no longer runs that consumer in the
-- emitting request: it enqueues the delivery with inline_result 'deferred',
-- and the outbox dispatcher runs the consumer (lib/events/outbox-dispatcher.ts).
-- The value is the decision itself, taken once per event by the instance that
-- emitted it: the dispatcher runs a delivery only when it says 'deferred', so
-- an event is never run both inline and from the queue, whatever switch the
-- dispatching instance has (a rolling deploy, a switch flipped back).
--
-- Expanded from the constraint's current definition (20261017120000), NOT
-- VALID; the VALIDATE runs in 20261018110100.
--
-- pg-test: tests/pg/event-outbox-async.pg.test.ts

-- event_deliveries is written by every emit in shadow mode: fail the
-- migration job instead of queueing writes behind a long transaction.
SELECT set_config('lock_timeout', '5s', true);

ALTER TABLE public.event_deliveries
  DROP CONSTRAINT event_deliveries_inline_result_check,
  ADD CONSTRAINT event_deliveries_inline_result_check
    CHECK (inline_result IN ('ok', 'failed', 'not_subscribed', 'deferred')) NOT VALID;

COMMENT ON COLUMN public.event_deliveries.inline_result IS
  'What the same consumer did inline in the emitting request (EVENT_OUTBOX_MODE=shadow): ok, failed or not_subscribed, compared with the deliveries by event_outbox_shadow_counts; deferred: the bus did not run it inline and the dispatcher runs it (EVENT_DELIVERY_<consumer>=outbox), reconciled by event_outbox_async_counts.';
