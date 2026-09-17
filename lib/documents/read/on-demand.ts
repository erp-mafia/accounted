import type { SupabaseClient } from '@supabase/supabase-js'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { enqueueDocumentJob } from '@/lib/documents/jobs/queue'
import { createLogger } from '@/lib/logger'
import { needsReadOnDemand } from './lanes'
import { LANE_COLUMNS, readAndStoreDocument, type ReadableDocumentRow, type StoreOutcome } from './store'

const log = createLogger('documents/read/on-demand')

export type OnDemandOutcome = StoreOutcome | { status: 'skipped'; reason: 'already_read' | 'not_found' }

/**
 * A question reaches a document the lanes left unread or half read: read it
 * now, in full, and let the pipeline type it afterwards. Reads what was
 * already read as a no-op. The lanes' economy is that this is the only way
 * a voucher-tied scan from years ago ever costs a model page.
 */
export async function ensureDocumentRead(supabase: SupabaseClient, companyId: string, documentId: string): Promise<OnDemandOutcome> {
  const { data, error } = await supabase.from('document_attachments').select(LANE_COLUMNS).eq('id', documentId).eq('company_id', companyId).maybeSingle()
  if (error) throw new Error(`document fetch failed: ${error.message}`)
  if (!data) return { status: 'skipped', reason: 'not_found' }
  const doc = data as ReadableDocumentRow
  if (!needsReadOnDemand(doc)) return { status: 'skipped', reason: 'already_read' }
  const out = await readAndStoreDocument(supabase, doc, { allowModel: isArkivEnabled(doc.company_id), maxModelPages: null })
  if (out.status === 'read' && !doc.doc_type && doc.company_id && isArkivEnabled(doc.company_id)) {
    try {
      await enqueueDocumentJob(supabase, doc.company_id, doc.id, 'classify')
    } catch (err) {
      log.warn('classify not queued after on-demand read', { doc: doc.id, reason: err instanceof Error ? err.message : String(err) })
    }
  }
  return out
}
