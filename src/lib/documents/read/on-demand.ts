import type { SupabaseClient } from '@supabase/supabase-js'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { hasStoredPages } from '@/lib/documents/locked-period'
import { createLogger } from '@/lib/logger'
import { historyReaderTier, needsReadOnDemand, readLaneFor } from './lanes'
import { readAndStoreDocument, type ReadableDocumentRow, type StoreOutcome } from './store'

const log = createLogger('documents/read/on-demand')

export type OnDemandOutcome = StoreOutcome | { status: 'skipped'; reason: 'already_read' | 'not_found' }

/**
 * A question reaches a document the lanes left unread or half read: read it
 * now, in full, and let the pipeline type it afterwards. Reads what was
 * already read as a no-op. The lanes' economy is that this is the only way
 * a voucher-tied scan from years ago ever costs a model page.
 */
export async function ensureDocumentRead(supabase: SupabaseClient, companyId: string, documentId: string): Promise<OnDemandOutcome> {
  const { data, error } = await supabase.from('document_attachments').select('id, company_id, storage_path, mime_type, created_at, journal_entry_id, journal_entry_line_id, doc_type, pages_read_at, read_error').eq('id', documentId).eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(`document fetch failed: ${error.message}`)
  if (!data) return { status: 'skipped', reason: 'not_found' }
  const doc = data as ReadableDocumentRow
  if (!needsReadOnDemand(doc)) return { status: 'skipped', reason: 'already_read' }
  // Pages stored but never stamped: the period lock held the row (lib/documents/locked-period.ts). Read once, not on every open.
  if (!doc.pages_read_at && (await hasStoredPages(supabase, doc.id))) return { status: 'skipped', reason: 'already_read' }
  // History is read by the history reader even when a question fetches it; a live document keeps the extraction tier.
  const tier = readLaneFor(doc) === 'live' ? undefined : historyReaderTier()
  const out = await readAndStoreDocument(supabase, doc, { allowModel: isArkivEnabled(doc.company_id), maxModelPages: null, tier })
  if (out.status === 'read' && !doc.doc_type && doc.company_id && isArkivEnabled(doc.company_id)) {
    try {
      await enqueueDocumentJob(supabase, doc.company_id, doc.id, 'classify')
    } catch (err) {
      log.warn('classify not queued after on-demand read', { doc: doc.id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
