import type { CoreEvent, CoreEventType, EventHandler } from './types'
import { createLogger } from '@/lib/logger'
import { whenInitialized } from '@/lib/initialized'
import { globalSingleton } from '@/lib/global-singleton'
import {
  eventDelivery,
  eventOutboxMode,
  isIndexedConsumer,
  outboxConsumerIds,
  outboxSwitchedConsumerIds,
} from './consumer-index'

// Internal handler type: loose enough for the Map, but type-safe at the public API
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (payload: any) => Promise<void> | void

const log = createLogger('event-bus')

/**
 * What a consumer did inline in the emitting request, as the shadow enqueue
 * records it; 'deferred' when the bus did not run it because its switch says
 * outbox (the dispatcher runs it).
 */
export type InlineResult = 'ok' | 'failed' | 'not_subscribed' | 'deferred'

/** One outbox delivery the bus asks for in shadow mode: a consumer and its inline result. */
export interface ShadowDelivery {
  readonly consumerId: string
  readonly inline: InlineResult
}

/**
 * Writes an event and its deliveries to the event outbox (lib/events/outbox.ts,
 * set by lib/init). The bus imports no writer itself: it is in the graph of
 * every server entry and may reach nothing but the consumer index.
 */
export type OutboxWriter = (event: CoreEvent, deliveries: readonly ShadowDelivery[]) => Promise<void>

/**
 * In-process event bus.
 *
 * - Handlers run concurrently via Promise.allSettled (failing handler never crashes emitter)
 * - emit() resolves only after every handler has settled: await it, so the
 *   handlers (event_log, webhooks, extensions) finish before the request does
 * - The handlers are wired by lib/init, which instrumentation.ts loads when
 *   the server boots; emit() waits for that load before its first dispatch
 *   (lib/initialized.ts). No caller has to initialise anything first.
 * - One bus per process (persists across requests), kept on globalThis: the
 *   copy of this module lib/init subscribes through is not the copy a route
 *   emits through (lib/global-singleton.ts)
 * - One-way: core services emit, extensions subscribe
 * - Rejected handlers are logged with structured fields so they're greppable
 *   in Vercel logs by event type, handler name, and the originating request id
 *   (when carried in the payload).
 * - EVENT_OUTBOX_MODE=shadow (lib/events/consumer-index.ts; off by default):
 *   after the handlers settled, the event is also enqueued in the event
 *   outbox for its consumers other than event-log, with what each did
 *   inline. Nothing more runs; a failed or impossible enqueue is logged and
 *   skipped, never thrown. With the mode off emit() does exactly what it did
 *   before the outbox existed.
 * - A consumer switched to the outbox (EVENT_DELIVERY_<CONSUMER>=outbox,
 *   consumer-index.ts, step E3) with the mode shadow and a writer installed
 *   is not run inline: it is enqueued as 'deferred' and the outbox dispatcher
 *   runs it. Decided here, per event, by the instance that emits. When the
 *   enqueue fails the deferred consumers run inline after all, as before:
 *   a rare duplicate (an enqueue that timed out but landed) beats a lost
 *   delivery. With the mode off the switch is ignored, logged once.
 */
const NO_CONSUMERS: ReadonlySet<string> = new Set()

class EventBus {
  private handlers = new Map<string, Set<AnyHandler>>()
  private outboxWriter: OutboxWriter | null = null
  private ignoredSwitchLogged = false

  on<T extends CoreEventType>(
    eventType: T,
    handler: EventHandler<T>
  ): () => void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set())
    }

    const handlerSet = this.handlers.get(eventType)!
    handlerSet.add(handler as AnyHandler)

    return () => {
      handlerSet.delete(handler as AnyHandler)
      if (handlerSet.size === 0) {
        this.handlers.delete(eventType)
      }
    }
  }

  async emit(event: CoreEvent): Promise<void> {
    try {
      await whenInitialized()
    } catch (err) {
      // Same contract as a failing handler: logged, never thrown at the
      // emitter, whose write has already happened. The next emit retries the
      // load. Whatever was registered before the failure still runs below.
      const payload = event.payload as Record<string, unknown>
      log.error('initialisation failed before dispatch', err, {
        eventType: event.type,
        companyId: typeof payload.companyId === 'string' ? payload.companyId : undefined,
        userId: typeof payload.userId === 'string' ? payload.userId : undefined,
      })
    }

    const mode = eventOutboxMode()
    if (mode === 'off') this.logIgnoredSwitches()
    const deferred = mode === 'shadow' ? this.deferredConsumers(event.type) : NO_CONSUMERS

    const handlerSet = this.handlers.get(event.type)
    const subscribed = handlerSet ? [...handlerSet] : []
    const handlers = deferred.size === 0 ? subscribed : subscribed.filter((handler) => !deferred.has(handler.name))
    const results = handlers.length > 0 ? await this.run(event, handlers) : []

    if (mode !== 'shadow') return
    const enqueued = await this.enqueueShadow(event, handlers, results, deferred)
    if (enqueued || deferred.size === 0) return

    // Not in the outbox: nothing would ever run the deferred consumers. Run
    // them here, as before the switch.
    const fallback = subscribed.filter((handler) => deferred.has(handler.name))
    log.warn('event outbox enqueue failed: deferred consumers ran inline', {
      eventType: event.type,
      consumers: [...deferred],
    })
    if (fallback.length > 0) await this.run(event, fallback)
  }

  /** Run handlers concurrently; a rejection is logged, never thrown. */
  private async run(event: CoreEvent, handlers: AnyHandler[]): Promise<PromiseSettledResult<void>[]> {
    const results = await Promise.allSettled(
      handlers.map((handler) => handler(event.payload))
    )

    for (let i = 0; i < results.length; i++) {
      const result = results[i]
      if (result.status === 'rejected') {
        const handler = handlers[i]
        const handlerName = handler.name || 'anonymous'
        const payload = event.payload as Record<string, unknown>

        log.error('handler failed', result.reason, {
          eventType: event.type,
          handler: handlerName,
          companyId: typeof payload.companyId === 'string' ? payload.companyId : undefined,
          userId: typeof payload.userId === 'string' ? payload.userId : undefined,
        })
      }
    }
    return results
  }

  /**
   * The consumers of this event type the outbox delivers instead of the bus:
   * its outbox consumers whose switch says outbox, when a writer is
   * installed (without one nothing could enqueue them). Shadow mode only.
   */
  private deferredConsumers(eventType: string): ReadonlySet<string> {
    if (!this.outboxWriter) return NO_CONSUMERS
    const ids = outboxConsumerIds(eventType).filter((consumerId) => eventDelivery(consumerId) === 'outbox')
    return ids.length === 0 ? NO_CONSUMERS : new Set(ids)
  }

  /** A delivery switch set to outbox while the outbox mode is off: logged once per process. */
  private logIgnoredSwitches(): void {
    if (this.ignoredSwitchLogged) return
    const switched = outboxSwitchedConsumerIds()
    if (switched.length === 0) return
    this.ignoredSwitchLogged = true
    log.warn('event delivery switch ignored: EVENT_OUTBOX_MODE is off, the consumers stay inline', {
      consumers: switched,
    })
  }

  /**
   * Set (or with null remove) what writes the event outbox. lib/init sets
   * it; emit() calls it only when EVENT_OUTBOX_MODE is shadow.
   */
  setOutboxWriter(writer: OutboxWriter | null): void {
    this.outboxWriter = writer
  }

  /**
   * Shadow mode: enqueue the event for its outbox consumers, recording what
   * each did inline (a subscription is named after its consumer,
   * subscribeEventConsumers), or 'deferred' for the ones the bus left to the
   * dispatcher. A consumer that ran inline but is not in the consumer index
   * for this type would never get a delivery: logged, so the reconciliation
   * can count it. Never throws; answers whether the event is in the outbox
   * (true too when it has no outbox consumer).
   */
  private async enqueueShadow(
    event: CoreEvent,
    handlers: AnyHandler[],
    results: PromiseSettledResult<void>[],
    deferred: ReadonlySet<string>,
  ): Promise<boolean> {
    const inline = new Map<string, InlineResult>()
    for (let i = 0; i < handlers.length; i++) {
      const consumerId = handlers[i].name
      inline.set(consumerId, results[i].status === 'fulfilled' ? 'ok' : 'failed')
      if (!isIndexedConsumer(event.type, consumerId)) {
        log.warn('event consumer ran inline outside the consumer index', {
          eventType: event.type,
          consumerId: consumerId || 'anonymous',
        })
      }
    }

    const consumerIds = outboxConsumerIds(event.type)
    if (consumerIds.length === 0) return true
    const writer = this.outboxWriter
    if (!writer) return false

    const deliveries = consumerIds.map((consumerId): ShadowDelivery => ({
      consumerId,
      inline: deferred.has(consumerId) ? 'deferred' : (inline.get(consumerId) ?? 'not_subscribed'),
    }))
    try {
      await writer(event, deliveries)
      return true
    } catch (err) {
      log.warn('event outbox shadow enqueue failed', {
        eventType: event.type,
        consumers: consumerIds,
        error: err instanceof Error ? err.message : String(err),
      })
      return false
    }
  }

  /** Remove all handlers and forget the once-per-process logs (useful for testing). */
  clear(): void {
    this.handlers.clear()
    this.ignoredSwitchLogged = false
  }
}

/** Process-wide singleton, shared by every copy of this module. */
export const eventBus = globalSingleton('eventBus', () => new EventBus())
