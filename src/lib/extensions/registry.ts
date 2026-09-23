import { eventBus } from '@/lib/events/bus'
import type { CoreEventType } from '@/lib/events/types'
import type { Extension, ExtensionContext } from './types'
import type { SupabaseClient } from '@supabase/supabase-js'

/** Factory function type for creating extension contexts */
export type ContextFactory = (
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  extensionId: string
) => ExtensionContext

/** Lazy-loaded context factory: set during initialization */
let contextFactory: ContextFactory | null = null

/**
 * Set the context factory used to build ExtensionContext for event handlers.
 * Called once during system initialization.
 */
export function setContextFactory(factory: ContextFactory): void {
  contextFactory = factory
}

/**
 * Extension Registry: singleton that manages extension lifecycle.
 *
 * - register() stores extension and wires event handlers to the bus
 * - unregister() unhooks handlers and removes extension
 * - getAll(), get(), getByCapability() for querying
 */
class ExtensionRegistry {
  private extensions = new Map<string, Extension>()
  private unsubscribers = new Map<string, (() => void)[]>()

  /**
   * Register an extension: store it and wire its event handlers to the bus.
   *
   * Each handler is wrapped so it receives `(payload, ctx)`. The context is
   * built lazily when the event fires, using the userId from the payload and
   * a Supabase client created from the current request cookies.
   */
  register(extension: Extension): void {
    if (this.extensions.has(extension.id)) {
      // Extension already registered: skip silently (expected during hot reloads)
      return
    }

    this.extensions.set(extension.id, extension)

    // Wire event handlers to the bus
    const unsubs: (() => void)[] = []
    if (extension.eventHandlers) {
      for (const { eventType, handler } of extension.eventHandlers) {
        // Wrap handler to inject ExtensionContext as second argument
        const wrappedHandler = async (payload: { userId: string; companyId?: string; [key: string]: unknown }) => {
          let ctx: ExtensionContext | undefined
          if (contextFactory && payload.userId) {
            try {
              // Dynamic import to avoid circular deps at module load time
              const { createClient } = await import('@/lib/supabase/server')
              const supabase = await createClient()
              const companyId = payload.companyId ?? payload.userId // fallback for legacy events
              ctx = contextFactory(supabase, payload.userId, companyId, extension.id)
            } catch {
              // Context creation failed (e.g. no request cookies in cron jobs).
              // Handler still gets called: ctx will be undefined.
            }
          }
          return handler(payload, ctx)
        }

        const unsub = eventBus.on(eventType as CoreEventType, wrappedHandler)
        unsubs.push(unsub)
      }
    }
    this.unsubscribers.set(extension.id, unsubs)
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
  getAll(): Extension[] {
    return [...this.extensions.values()]
  }

  /** Get a specific extension by ID. */
  get(id: string): Extension | undefined {
    return this.extensions.get(id)
  }

  /** Get all extensions that have a specific capability. */
  getByCapability(key: keyof Extension): Extension[] {
    return [...this.extensions.values()].filter(
      (ext) => ext[key] !== undefined && ext[key] !== null
    )
  }

  /** Clear all extensions (useful for testing). */
  clear(): void {
    for (const id of this.extensions.keys()) {
      this.unregister(id)
    }
  }
}

/** Module-level singleton */
export const extensionRegistry = new ExtensionRegistry()
