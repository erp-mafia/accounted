import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { getAiStatus } from '@/lib/ai'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { createLogger } from '@/lib/logger'
import { readDocumentBytes } from './router'
import { READER_UNAVAILABLE, ReaderUnavailableError, readerForMime, type ReadOutcome } from './types'

const log = createLogger('documents/read')

export interface ReadableDocumentRow {
  id: string
  company_id: string | null
  storage_path: string
  mime_type: string | null
}

export type StoreOutcome =
  | { status: 'read'; pages: number; reader: string; partial?: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }

export const isReaderUnavailable = (out: StoreOutcome) => out.status === 'error' && out.reason.startsWith(READER_UNAVAILABLE)

/** Reasons the backfill retries later: the model was gated or unconfigured when the row was read. */
const RETRY_REASONS = ['ai_gated', 'ai_unconfigured', 'partial:ai_gated', 'partial:ai_unconfigured']

/**
 * Read one document and store its pages. Idempotent: pages for the document
 * are replaced, and pages_read_at is stamped on every outcome about the
 * document so the backfill moves on (read_error names why when no or only some
 * pages were produced). A reader that could not be loaded is an outcome about
 * the environment: nothing is stamped and the document stays unread.
 * Never touches the file itself. The model is called only for companies in
 * the Arkiv rollout; text layers are read for everyone.
 */
export async function readAndStoreDocument(
  supabase: SupabaseClient,
  doc: ReadableDocumentRow,
  opts: { allowModel?: boolean } = {},
): Promise<StoreOutcome> {
  const allowModel = opts.allowModel ?? isArkivEnabled(doc.company_id)
  if (!doc.company_id) return stamp(supabase, doc.id, { status: 'skipped', reason: 'no_company' }, null)
  const kind = readerForMime(doc.mime_type)
  if (kind === null) return stamp(supabase, doc.id, { status: 'skipped', reason: 'unsupported_mime' }, null)
  if (kind === 'structured') return stamp(supabase, doc.id, { status: 'skipped', reason: 'structured' }, null)

  const { blob, error } = await downloadDocumentObject(supabase, doc.storage_path, doc.company_id)
  if (error || !blob) {
    return stamp(supabase, doc.id, { status: 'error', reason: `download_failed: ${error?.message ?? 'no data'}` }, null)
  }
  const bytes = Buffer.from(await blob.arrayBuffer())

  let outcome: ReadOutcome
  try {
    outcome = await readDocumentBytes(bytes, doc.mime_type, { allowModel })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (err instanceof ReaderUnavailableError) {
      // Not stamped: the document is fine, the reader is missing. It stays unread for the next run.
      log.warn('reader unavailable, document left unread', { doc: doc.id, mime: doc.mime_type, reason })
      return { status: 'error', reason: `${READER_UNAVAILABLE}: ${reason.slice(0, 300)}` }
    }
    log.warn('read failed', { doc: doc.id, mime: doc.mime_type, reason })
    return stamp(supabase, doc.id, { status: 'error', reason: `read_failed: ${reason.slice(0, 300)}` }, null)
  }
  if (!outcome.ok) {
    // Stamped with the reason: the backfill's retry pass picks ai_* rows up
    // again once the company is in the rollout and a model is configured.
    return stamp(supabase, doc.id, { status: 'skipped', reason: outcome.skipped }, 0)
  }

  const rows = outcome.pages.map((p) => ({
    company_id: doc.company_id,
    document_id: doc.id,
    page_no: p.pageNo,
    text: p.text,
    words: p.words ?? null,
    page_width: p.pageWidth ?? null,
    page_height: p.pageHeight ?? null,
    reader: p.reader,
    has_text_layer: p.hasTextLayer,
  }))
  const { error: delError } = await supabase.from('document_pages').delete().eq('document_id', doc.id)
  if (delError) return stamp(supabase, doc.id, { status: 'error', reason: `pages_delete_failed: ${delError.message}` }, null)
  const { error: insError } = await supabase.from('document_pages').insert(rows)
  if (insError) return stamp(supabase, doc.id, { status: 'error', reason: `pages_insert_failed: ${insError.message}` }, null)
  return stamp(
    supabase,
    doc.id,
    { status: 'read', pages: rows.length, reader: outcome.reader, ...(outcome.partial ? { partial: `partial:${outcome.partial}` } : {}) },
    outcome.pageCount,
  )
}

async function stamp(supabase: SupabaseClient, documentId: string, outcome: StoreOutcome, pageCount: number | null): Promise<StoreOutcome> {
  const readError = outcome.status === 'read' ? (outcome.partial ?? null) : outcome.reason
  const { error } = await supabase
    .from('document_attachments')
    .update({ pages_read_at: new Date().toISOString(), page_count: pageCount, read_error: readError })
    .eq('id', documentId)
  if (error) log.warn('stamp failed', { doc: documentId, err: error.message })
  return outcome
}

/**
 * Backfill: the newest unread documents first; when that batch is not full,
 * documents whose model pages were gated or unconfigured last time, but only
 * for companies now in the rollout and only when a model is configured.
 */
export async function readUnreadDocuments(supabase: SupabaseClient, limit: number): Promise<{ processed: number; read: number; skipped: number; errors: number }> {
  const counts = { processed: 0, read: 0, skipped: 0, errors: 0 }
  const tally = (out: StoreOutcome) => {
    counts.processed++
    if (out.status === 'read') counts.read++
    else if (out.status === 'skipped') counts.skipped++
    else counts.errors++
  }
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id, company_id, storage_path, mime_type')
    .is('pages_read_at', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetch unread documents failed: ${error.message}`)
  for (const doc of (data ?? []) as ReadableDocumentRow[]) {
    const out = await readAndStoreDocument(supabase, doc)
    tally(out)
    // A missing reader fails every document the same way: stop, leave the rest unread, try again next run.
    if (isReaderUnavailable(out)) return counts
  }

  const room = limit - counts.processed
  if (room <= 0 || !getAiStatus().configured) return counts
  const { data: retry, error: retryError } = await supabase
    .from('document_attachments')
    .select('id, company_id, storage_path, mime_type')
    .in('read_error', RETRY_REASONS)
    .order('pages_read_at', { ascending: true })
    .limit(room * 4)
  if (retryError) throw new Error(`fetch retry documents failed: ${retryError.message}`)
  let taken = 0
  for (const doc of (retry ?? []) as ReadableDocumentRow[]) {
    if (taken >= room) break
    if (!isArkivEnabled(doc.company_id)) continue
    taken++
    const out = await readAndStoreDocument(supabase, doc, { allowModel: true })
    tally(out)
    if (isReaderUnavailable(out)) return counts
  }
  return counts
}
