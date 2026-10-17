import type { CoreEvent, CoreEventType, EventHandler } from './types'
import { createLogger } from '@/lib/logger'
import { whenInitialized } from '@/lib/initialized'
import { globalSingleton } from '@/lib/global-singleton'
import { eventOutboxMode, isIndexedConsumer, outboxConsumerIds } from './consumer-index'

// Internal handler type: loose enough for the Map, but type-safe at the public API
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (payload: any) => Promise<void> | void

const log = createLogger('event-bus')

/** What a consumer did inline in the emitting request, as the shadow enqueue records it. */
export type InlineResult = 'ok' | 'failed' | 'not_subscribed'

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
 */
class EventBus {
  private handlers = new Map<string, Set<AnyHandler>>()
  private outboxWriter: OutboxWriter | null = null

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

    const handlerSet = this.handlers.get(event.type)
    if (!handlerSet || handlerSet.size === 0) {
      if (eventOutboxMode() === 'shadow') await this.enqueueShadow(event, [], [])
      return
    }

    const handlers = [...handlerSet]
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

    if (eventOutboxMode() === 'shadow') await this.enqueueShadow(event, handlers, results)
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
   * subscribeEventConsumers). A consumer that ran inline but is not in the
   * consumer index for this type would never get a delivery: logged, so the
   * reconciliation can count it. Never throws.
   */
  private async enqueueShadow(event: CoreEvent, handlers: AnyHandler[], results: PromiseSettledResult<void>[]): Promise<void> {
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
    const writer = this.outboxWriter
    if (consumerIds.length === 0 || !writer) return

    const deliveries = consumerIds.map((consumerId) => ({
      consumerId,
      inline: inline.get(consumerId) ?? 'not_subscribed',
    }))
    try {
      await writer(event, deliveries)
    } catch (err) {
      log.warn('event outbox shadow enqueue failed', {
        eventType: event.type,
        consumers: consumerIds,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  /** Remove all handlers (useful for testing). */
  clear(): void {
    this.handlers.clear()
  }
}

/** Process-wide singleton, shared by every copy of this module. */
export const eventBus = globalSingleton('eventBus', () => new EventBus())
