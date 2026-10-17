import { subscribeEventConsumers, type EventConsumer } from '@/lib/events/consumers'
import { whenInitialized } from '@/lib/initialized'
import { globalSingleton } from '@/lib/global-singleton'
import type { CoreEventType } from '@/lib/events/types'
import type { Extension, ExtensionContext, ExtensionEventHandler } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Factory function type for creating extension contexts */
export type ContextFactory = (
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  extensionId: string
) => ExtensionContext

/**
 * The context factory, set during initialization. Process-wide like the
 * registry itself (lib/global-singleton.ts): lib/init sets it through its own
 * copy of this module, and the handler wrappers read it from whichever copy
 * created the registry.
 */
const contextFactoryHolder = globalSingleton(
  'extensionContextFactory',
  (): { factory: ContextFactory | null } => ({ factory: null }),
)

/**
 * Set the context factory used to build ExtensionContext for event handlers.
 * Called once during system initialization.
 */
export function setContextFactory(factory: ContextFactory): void {
  contextFactoryHolder.factory = factory
}

/**
 * Extension Registry: singleton that manages extension lifecycle.
 *
 * - register() stores extension and wires event handlers to the bus
 * - unregister() unhooks handlers and removes extension
 * - getAll(), get() for querying; async because they wait for lib/init, which
 *   instrumentation.ts loads when the server boots (lib/initialized.ts), so a
 *   read can never see the registry before lib/init has filled it
 * - One registry per process, kept on globalThis (lib/global-singleton.ts)
 */
class ExtensionRegistry {
  private extensions = new Map<string, Extension>()
  private unsubscribers = new Map<string, (() => void)[]>()

  /**
   * Register an extension: store it and wire its event handlers to the bus,
   * as the extension's event consumer (extensionEventConsumer below).
   */
  register(extension: Extension): void {
    if (this.extensions.has(extension.id)) {
      // Extension already registered: skip silently (expected during hot reloads)
      return
    }

    this.extensions.set(extension.id, extension)

    const consumer = extensionEventConsumer(extension)
    this.unsubscribers.set(extension.id, consumer ? subscribeEventConsumers([consumer]) : [])
  }

  /**
   * Unregister an extension: unhook all event handlers and remove.
   */
  unregister(extensionId: string): void {
    const unsubs = this.unsubscribers.get(extensionId)
    if (unsubs) {
      for (const unsub of unsubs) {
        unsub()
      }
      this.unsubscribers.delete(extensionId)
    }
    this.extensions.delete(extensionId)
  }

  /** Get all registered extensions. */
  async getAll(): Promise<Extension[]> {
    await whenInitialized()
    return [...this.extensions.values()]
  }

  /** Get a specific extension by ID. */
  async get(id: string): Promise<Extension | undefined> {
    await whenInitialized()
    return this.extensions.get(id)
  }

  /** Clear all extensions (useful for testing). */
  clear(): void {
    for (const id of this.extensions.keys()) {
      this.unregister(id)
    }
  }
}

/** Process-wide singleton, shared by every copy of this module. */
export const extensionRegistry = globalSingleton('extensionRegistry', () => new ExtensionRegistry())

/**
 * An extension's event handlers as one event consumer, `ext:<extension id>`,
 * subscribed to each event type it handles; null when it handles none.
 *
 * Each handler receives `(payload, ctx)`. The context is built lazily when
 * the event fires, using the userId from the payload and a Supabase client
 * created from the current request cookies. Several handlers of one
 * extension for the same event type run concurrently and all settle before
 * the delivery does; the first failure is the one rethrown to the bus.
 */
export function extensionEventConsumer(extension: Extension): EventConsumer | null {
  const handlersByType = new Map<CoreEventType, ExtensionEventHandler['handler'][]>()
  for (const { eventType, handler } of extension.eventHandlers ?? []) {
    handlersByType.set(eventType, [...(handlersByType.get(eventType) ?? []), handler])
  }
  if (handlersByType.size === 0) return null

  const id = `ext:${extension.id}` as const
  return {
    id,
    owner: id,
    eventTypes: [...handlersByType.keys()],
    handle(event) {
      const handlers = handlersByType.get(event.type) ?? []
      const payload = event.payload as ExtensionEventPayload
      if (handlers.length === 1) return runExtensionHandler(extension.id, handlers[0], payload)
      return settleAll(handlers.map((handler) => runExtensionHandler(extension.id, handler, payload)))
    },
  }
}

type ExtensionEventPayload = { userId: string; companyId?: string; [key: string]: unknown }

async function runExtensionHandler(
  extensionId: string,
  handler: ExtensionEventHandler['handler'],
  payload: ExtensionEventPayload,
): Promise<void> {
  let ctx: ExtensionContext | undefined
  const contextFactory = contextFactoryHolder.factory
  if (contextFactory && payload.userId) {
    try {
      // Dynamic import to avoid circular deps at module load time
      const { createClient } = await import('@/lib/supabase/server')
      const supabase = await createClient()
      const companyId = payload.companyId ?? payload.userId // fallback for legacy events
      ctx = contextFactory(supabase, payload.userId, companyId, extensionId)
    } catch {
      // Context creation failed (e.g. no request cookies in cron jobs).
      // Handler still gets called: ctx will be undefined.
    }
  }
  return handler(payload, ctx)
}

async function settleAll(deliveries: Promise<void>[]): Promise<void> {
  const failed = (await Promise.allSettled(deliveries)).find((r) => r.status === 'rejected')
  if (failed) throw failed.reason
}
