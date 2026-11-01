import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { readerForMime } from '@/lib/documents/read/types'

/**
 * Arkiv: every uploaded document gets a read job at arrival. The worker cron
 * reads it into page text and, for companies in the rollout, classifies and
 * extracts it. Nothing here waits on a model, and a failure to queue never
 * fails the upload: it throws to the event bus, which logs it as an error
 * with the event type and this consumer's name and keeps it from the upload
 * (lib/events/bus.ts), and the read backfill cron picks up anything left
 * unread.
 *
 * A structured archive (a bank response, an XML payload) is the record
 * itself and is never read into pages: it gets no job. Before 2026-09-24 the
 * bank sync's JSON files took a read slot each and a person's PDF waited
 * behind a hundred no-ops (prod: 112 queued for one company, 3 a minute).
 */
export function registerDocumentReadHandler(): () => void {
  return eventBus.on('document.uploaded', enqueueDocumentRead)
}

/** The document.uploaded handler; lib/init subscribes it through EVENT_CONSUMERS (lib/composition/event-consumers.ts). */
export async function enqueueDocumentRead({ document, companyId }: EventPayload<'document.uploaded'>): Promise<void> {
  const company = document.company_id ?? companyId
  if (!company) return
  if (readerForMime(document.mime_type) === 'structured') return
  await enqueueDocumentJob(createServiceClientNoCookies(), company, document.id, 'read')
}
