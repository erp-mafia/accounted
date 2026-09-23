import { eventBus } from '@/lib/events/bus'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { createLogger } from '@/lib/logger'

const log = createLogger('document-read')

/**
 * Arkiv: every uploaded document gets a read job at arrival. The worker cron
 * reads it into page text and, for companies in the rollout, classifies and
 * extracts it. Nothing here waits on a model, and a failure to queue never
 * fails the upload: the read backfill cron picks up anything left unread.
 */
export function registerDocumentReadHandler(): () => void {
  return eventBus.on('document.uploaded', async ({ document, companyId }) => {
    const company = document.company_id ?? companyId
    if (!company) return
    try {
      await enqueueDocumentJob(createServiceClientNoCookies(), company, document.id, 'read')
    } catch (err) {
      log.warn('document read enqueue failed', { doc: document.id, reason: err instanceof Error ? err.message : String(err) })
    }
  })
}
