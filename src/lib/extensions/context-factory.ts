import type { SupabaseClient } from '@supabase/supabase-js'
import type { CoreEvent } from '@/lib/events/types'
import { eventBus } from '@/lib/events/bus'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { createLogger } from '@/lib/logger'
import type {
  ExtensionContext,
  ExtensionLogger,
  ExtensionSettings,
  ExtensionServices,
} from './types'

/**
 * Create a prefixed logger for an extension. When `bind` is supplied the
 * fields (e.g. requestId, userId, companyId) are merged into every log line.
 */
function createExtLogger(extensionId: string, bind?: Record<string, unknown>): ExtensionLogger {
  const logger = bind
    ? createLogger(`ext:${extensionId}`, bind)
    : createLogger(`ext:${extensionId}`)
  return {
    info: (message: string, ...args: unknown[]) => logger.info(message, ...args),
    warn: (message: string, ...args: unknown[]) => logger.warn(message, ...args),
    error: (message: string, ...args: unknown[]) => logger.error(message, ...args),
  }
}

/**
 * Create a settings accessor scoped to a specific extension.
 */
function createSettings(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  extensionId: string
): ExtensionSettings {
  return {
    async get<T>(key?: string): Promise<T | null> {
      const lookupKey = key ?? 'settings'
      const { data } = await supabase
        .from('extension_data')
        .select('value')
        .eq('company_id', companyId)
        .eq('extension_id', extensionId)
        .eq('key', lookupKey)
        .single()

      return (data?.value as T) ?? null
    },

    async set<T>(key: string, value: T): Promise<void> {
      const { error } = await supabase
        .from('extension_data')
        .upsert(
          {
            user_id: userId,
            company_id: companyId,
            extension_id: extensionId,
            key,
            value,
          },
          { onConflict: 'company_id,extension_id,key' }
        )
      if (error) {
        throw new Error(`extension_data set failed for ${extensionId}/${key}: ${error.message}`)
      }
    },

    async clear(key: string): Promise<void> {
      const { error } = await supabase
        .from('extension_data')
        .delete()
        .eq('company_id', companyId)
        .eq('extension_id', extensionId)
        .eq('key', key)
      if (error) {
        throw new Error(`extension_data clear failed for ${extensionId}/${key}: ${error.message}`)
      }
    },
  }
}

/**
 * Create core services exposed to extensions.
 */
function createServices(): ExtensionServices {
  return { ingestTransactions }
}

/**
 * Build a fully populated ExtensionContext.
 *
 * The context gives extensions access to Supabase, event emission, settings,
 * logging, and core services: without importing from core modules.
 *
 * `requestId` (when supplied by the dispatcher) flows through the bound logger
 * and is exposed on the context so handlers can pass it into
 * `errorResponseFromCode(...)` for the envelope + `X-Request-Id` header.
 */
export function createExtensionContext(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  extensionId: string,
  requestId?: string,
): ExtensionContext {
  const logBindings: Record<string, unknown> = { userId, companyId, extensionId }
  if (requestId) logBindings.requestId = requestId

  return {
    userId,
    companyId,
    extensionId,
    requestId,
    supabase,
    emit: (event: CoreEvent) => eventBus.emit(event),
    settings: createSettings(supabase, userId, companyId, extensionId),
    log: createExtLogger(extensionId, logBindings),
    services: createServices(),
  }
}
