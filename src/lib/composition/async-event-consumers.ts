/**
 * The event consumers the outbox dispatcher may run (step E3): the ones that
 * can be switched from inline delivery to the outbox, each behind its own
 * switch (ASYNC_CONSUMER_SWITCHES, lib/events/consumer-index.ts;
 * consumer-index.test.ts keeps the two lists equal). Webhooks only.
 *
 * The dispatcher (lib/events/outbox-dispatcher.ts) imports this list and
 * nothing else of the consumers, so the per-minute cron and the after() kick
 * compile the webhook fan-out but not every handler module EVENT_CONSUMERS
 * reaches. EVENT_CONSUMERS (./event-consumers.ts) lists the same objects, so
 * a consumer is declared once and runs the same code inline and from the
 * outbox.
 */
import { eventConsumer, type EventConsumer } from '@/lib/events/consumers'
import { fanOutEvent, WEBHOOK_EVENT_TYPES } from '@/lib/webhooks/handler'

// One webhook_deliveries row per matching webhook of the company. From the
// outbox (ctx.outbox), keyed by the outbox id and throwing on a failure to
// retry; inline, never throwing, as before.
export const WEBHOOKS_EVENT_CONSUMER: EventConsumer = eventConsumer({
  id: 'webhooks',
  owner: 'platform',
  eventTypes: WEBHOOK_EVENT_TYPES,
  handle: (event, ctx) => fanOutEvent(event.type, event.payload, ctx.outbox),
})

export const ASYNC_EVENT_CONSUMERS: readonly EventConsumer[] = Object.freeze([WEBHOOKS_EVENT_CONSUMER])
