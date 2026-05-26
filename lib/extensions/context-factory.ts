import type { SupabaseClient } from '@supabase/supabase-js'
import type { CoreEvent } from '@/lib/events/types'
import { eventBus } from '@/lib/events/bus'
import { ingestTransactions } from '@/lib/transactions/ingest'
import { listForCompany as cashAccountsList, getPrimary as cashAccountsGetPrimary } from '@/lib/cash-accounts/service'
import { createLogger } from '@/lib/logger'
import type {
  ExtensionContext,
  ExtensionLogger,
  ExtensionSettings,
  ExtensionStorage,
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
 * Create a storage accessor wrapping Supabase storage.
 */
function createStorage(supabase: SupabaseClient): ExtensionStorage {
  return {
    async download(bucket: string, path: string) {
      const { data, error } = await supabase.storage
        .from(bucket)
        .download(path)
      return { data, error: error?.message }
    },

    async upload(bucket: string, path: string, data: ArrayBuffer, options?: { contentType?: string }) {
      const { error } = await supabase.storage
        .from(bucket)
        .upload(path, data, options ? { contentType: options.contentType } : undefined)
      if (error) return { path: '', error: error.message }
      return { path }
    },

    getPublicUrl(bucket: string, path: string): string {
      const { data } = supabase.storage
        .from(bucket)
        .getPublicUrl(path)
      return data.publicUrl
    },
  }
}

/**
 * Create core services exposed to extensions.
 */
function createServices(): ExtensionServices {
  return {
    ingestTransactions,
    getCashAccounts: (supabase, companyId, opts) => cashAccountsList(supabase, companyId, opts),
    getPrimaryCashAccount: (supabase, companyId, currency) =>
      cashAccountsGetPrimary(supabase, companyId, currency),
  }
}

/**
 * Build a fully populated ExtensionContext.
 *
 * The context gives extensions access to Supabase, event emission, settings,
 * storage, logging, and core services — without importing from core modules.
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
    storage: createStorage(supabase),
    log: createExtLogger(extensionId, logBindings),
    services: createServices(),
  }
}
