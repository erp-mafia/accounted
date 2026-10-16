import { eventBus } from '@/lib/events/bus'
import { whenInitialized } from '@/lib/initialized'
import { globalSingleton } from '@/lib/global-singleton'
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
          const contextFactory = contextFactoryHolder.factory
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
