import type { CoreEvent, CoreEventType, EventHandler } from './types'
import { createLogger } from '@/lib/logger'

// Internal handler type: loose enough for the Map, but type-safe at the public API
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyHandler = (payload: any) => Promise<void> | void

const log = createLogger('event-bus')

/**
 * In-process event bus.
 *
 * - Handlers run concurrently via Promise.allSettled (failing handler never crashes emitter)
 * - Module-level singleton (persists across requests in same process)
 * - One-way: core services emit, extensions subscribe
 * - Rejected handlers are logged with structured fields so they're greppable
 *   in Vercel logs by event type, handler name, and the originating request id
 *   (when carried in the payload).
 */
class EventBus {
  private handlers = new Map<string, Set<AnyHandler>>()

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
    const handlerSet = this.handlers.get(event.type)
    if (!handlerSet || handlerSet.size === 0) return

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
  }

  /** Remove all handlers (useful for testing). */
  clear(): void {
    this.handlers.clear()
  }
}

/** Module-level singleton */
export const eventBus = new EventBus()
