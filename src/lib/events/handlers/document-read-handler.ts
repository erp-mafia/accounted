import { eventBus } from '@/lib/events/bus'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { readerForMime } from '@/lib/documents/read/types'
import { createLogger } from '@/lib/logger'

const log = createLogger('document-read')

/**
 * Arkiv: every uploaded document gets a read job at arrival. The worker cron
 * reads it into page text and, for companies in the rollout, classifies and
 * extracts it. Nothing here waits on a model, and a failure to queue never
 * fails the upload: the read backfill cron picks up anything left unread.
 *
 * A structured archive (a bank response, an XML payload) is the record
 * itself and is never read into pages: it gets no job. Before 2026-09-24 the
 * bank sync's JSON files took a read slot each and a person's PDF waited
 * behind a hundred no-ops (prod: 112 queued for one company, 3 a minute).
 */
export function registerDocumentReadHandler(): () => void {
  return eventBus.on('document.uploaded', async ({ document, companyId }) => {
    const company = document.company_id ?? companyId
    if (!company) return
    if (readerForMime(document.mime_type) === 'structured') return
    try {
      await enqueueDocumentJob(createServiceClientNoCookies(), company, document.id, 'read')
    } catch (err) {
      log.warn('document read enqueue failed', { doc: document.id, reason: err instanceof Error ? err.message : String(err) })
    }
  })
}
