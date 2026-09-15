import { eventBus } from '@/lib/events/bus'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { readAndStoreDocument } from '@/lib/documents/read/store'

const log = createLogger('document-read')

/**
 * Arkiv phase 1: read every uploaded document into page text at arrival.
 * Runs after the upload has committed; a failure here never fails the
 * upload, and the backfill cron retries anything left without pages_read_at.
 */
export function registerDocumentReadHandler(): () => void {
  return eventBus.on('document.uploaded', async ({ document, companyId }) => {
    try {
      const supabase = createServiceClientNoCookies()
      const outcome = await readAndStoreDocument(supabase, {
        id: document.id,
        company_id: document.company_id ?? companyId,
        storage_path: document.storage_path,
        mime_type: document.mime_type ?? null,
      })
      log.info('document read', { doc: document.id, outcome })
    } catch (err) {
      log.warn('document read failed', { doc: document.id, reason: err instanceof Error ? err.message : String(err) })
    }
  })
}
