import type { SupabaseClient } from '@supabase/supabase-js'
import type { ModuleId } from '@/lib/modules/manifest'
import { eventBus } from './bus'
import type { CoreEvent, CoreEventType, EventPayload } from './types'

/**
 * An event consumer: one named reaction to one or more event types. The core
 * consumers are listed in lib/composition/event-consumers.ts; each enabled
 * extension with event handlers is one consumer too, `ext:<extension id>`
 * (lib/extensions/registry.ts). lib/init subscribes them, so which handlers
 * run on which events is read from those two lists, not from hand-written
 * subscriptions (src/lib/events/__tests__/subscriptions.test.ts pins the set).
 *
 * Delivery is the bus's: inline in the request that emits, every
 * subscription of an event concurrently through Promise.allSettled
 * (bus.ts), in the order the consumers were subscribed. A consumer switched
 * to the outbox (lib/events/consumer-index.ts, eventDelivery) is instead run
 * by the outbox dispatcher after the request, with ctx.outbox set; its
 * handle() then throws on a failure the dispatcher should retry.
 */
export interface EventConsumer<T extends CoreEventType = CoreEventType> {
  /** Stable and unique: `ext:<extension id>` for an extension. Named in handler failure logs. */
  readonly id: string
  /** The module the reaction belongs to, or the extension that brings it. */
  readonly owner: EventConsumerOwner
  readonly eventTypes: readonly T[]
  handle(event: Extract<CoreEvent, { type: T }>, ctx: EventConsumerContext): Promise<void> | void
}

export type EventConsumerOwner = ModuleId | `ext:${string}`

/** What a delivery knows beyond the event: which consumer it is for, and whether it comes from the outbox. */
export interface EventConsumerContext {
  readonly consumerId: string
  /** Set when the outbox dispatcher delivers the event (lib/events/outbox-dispatcher.ts); absent inline. */
  readonly outbox?: OutboxDeliveryContext
}

/**
 * An outbox delivery. The outbox delivers at least once: the same delivery
 * can run again after a crash or an expired lease, so what the consumer
 * writes is keyed by outboxId and written insert-or-ignore.
 */
export interface OutboxDeliveryContext {
  /** event_outbox.id: the event's idempotency key. */
  readonly outboxId: number
  /** The claim's attempt, 1 on the first run. */
  readonly attempt: number
  /** The service-role client the dispatcher runs on. */
  readonly supabase: SupabaseClient
}

/**
 * Declare a consumer whose handle() is typed by its own event types, for a
 * list of consumers of any types. An identity at runtime; the widening is
 * sound because subscribeEventConsumers() only hands a consumer events of the
 * types it lists.
 */
export function eventConsumer<T extends CoreEventType>(consumer: EventConsumer<T>): EventConsumer {
  return consumer as unknown as EventConsumer
}

/**
 * Subscribe each consumer to each of its event types on the bus, in list
 * order: one bus subscription per (consumer, event type), so a consumer runs
 * once per event beside the others. The subscription is named after the
 * consumer, which is what the bus logs when it fails. Returns the
 * unsubscribe functions.
 */
export function subscribeEventConsumers(consumers: readonly EventConsumer[]): (() => void)[] {
  const unsubscribers: (() => void)[] = []
  for (const consumer of consumers) {
    const ctx: EventConsumerContext = Object.freeze({ consumerId: consumer.id })
    for (const type of consumer.eventTypes) {
      const deliver = (payload: EventPayload<typeof type>) => consumer.handle({ type, payload } as CoreEvent, ctx)
      Object.defineProperty(deliver, 'name', { value: consumer.id })
      unsubscribers.push(eventBus.on(type, deliver))
    }
  }
  return unsubscribers
}
