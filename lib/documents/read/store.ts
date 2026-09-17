import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { getAiStatus } from '@/lib/ai'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { createLogger } from '@/lib/logger'
import { recordArkivUsage } from '@/lib/arkiv/usage'
import { readDocumentBytes } from './router'
import { readLaneFor, readPlanFor, isActingType, type ReadPlan } from './lanes'
import { readerForMime, type ReadOutcome } from './types'

const log = createLogger('documents/read')

export interface ReadableDocumentRow {
  id: string
  company_id: string | null
  storage_path: string
  mime_type: string | null
  /** The lane fields (phase 9f); a row without them reads as live. */
  created_at?: string | null
  journal_entry_id?: string | null
  journal_entry_line_id?: string | null
  doc_type?: string | null
  pages_read_at?: string | null
  read_error?: string | null
}

/** Everything the lanes need to decide, in one select. */
export const LANE_COLUMNS = 'id, company_id, storage_path, mime_type, created_at, journal_entry_id, journal_entry_line_id, doc_type, pages_read_at, read_error'

export type StoreOutcome =
  | { status: 'read'; pages: number; reader: string; partial?: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }

/** Reasons the backfill retries later: the model was gated or unconfigured when the row was read. */
const RETRY_REASONS = ['ai_gated', 'ai_unconfigured', 'partial:ai_gated', 'partial:ai_unconfigured']

/**
 * Read one document and store its pages. Idempotent: pages for the document
 * are replaced, and pages_read_at is stamped on every outcome so the backfill
 * moves on (read_error names why when no or only some pages were produced).
 * Never touches the file itself. The model is called only for companies in
 * the Arkiv rollout; text layers are read for everyone.
 */
export async function readAndStoreDocument(
  supabase: SupabaseClient,
  doc: ReadableDocumentRow,
  opts: { allowModel?: boolean; maxModelPages?: number | null } = {},
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
    outcome = await readDocumentBytes(bytes, doc.mime_type, { allowModel, maxModelPages: opts.maxModelPages ?? null })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
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
  // The meter (phase 9e): every page read, and the model's pages once more as the costly kind. Every read path passes here.
  await recordArkivUsage(supabase, doc.company_id, 'pages_read', rows.length)
  const visionPages = rows.filter((r) => r.reader === 'claude_vision').length
  if (visionPages > 0) await recordArkivUsage(supabase, doc.company_id, 'pages_vision', visionPages)
  return stamp(
    supabase,
    doc.id,
    { status: 'read', pages: rows.length, reader: outcome.reader, ...(outcome.partial ? { partial: `partial:${outcome.partial}` } : {}) },
    outcome.pageCount,
  )
}

/** The lane's plan for this document now: null when nothing more is read up front. */
export function planForDocument(doc: ReadableDocumentRow, now = new Date()): ReadPlan | null {
  return readPlanFor({ lane: readLaneFor(doc, now), inRollout: isArkivEnabled(doc.company_id), docType: doc.doc_type ?? null, pagesRead: !!doc.pages_read_at })
}

/** Read what the lane says to read. The runner and the backfill both come through here. */
export async function readDocumentByPlan(supabase: SupabaseClient, doc: ReadableDocumentRow, now = new Date()): Promise<{ plan: ReadPlan | null; outcome: StoreOutcome | null }> {
  const plan = planForDocument(doc, now)
  if (!plan) return { plan: null, outcome: null }
  return { plan, outcome: await readAndStoreDocument(supabase, doc, { allowModel: plan.allowModel, maxModelPages: plan.maxModelPages }) }
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
 * Backfill: the newest unread documents first, each read by its lane; when
 * that batch is not full, documents whose model pages were gated or
 * unconfigured last time, but only for companies now in the rollout, only
 * when a model is configured, and for voucher-tied history only while the
 * company's daily page budget (ARKIV_BACKFILL_PAGES_PER_DAY) has room.
 */
export async function readUnreadDocuments(
  supabase: SupabaseClient,
  limit: number,
  opts: { budgetPagesPerDay?: number; now?: Date; onRead?: (doc: ReadableDocumentRow, outcome: Extract<StoreOutcome, { status: 'read' }>) => Promise<void> } = {},
): Promise<{ processed: number; read: number; skipped: number; errors: number }> {
  const now = opts.now ?? new Date()
  const budget = Math.max(0, Math.floor(opts.budgetPagesPerDay ?? 0))
  const counts = { processed: 0, read: 0, skipped: 0, errors: 0 }
  const tally = async (doc: ReadableDocumentRow, out: StoreOutcome) => {
    counts.processed++
    if (out.status === 'read') {
      counts.read++
      // The caller queues what follows a read (the classification); the store stays free of the queue.
      if (opts.onRead) await opts.onRead(doc, out)
    } else if (out.status === 'skipped') counts.skipped++
    else counts.errors++
  }
  const { data, error } = await supabase
    .from('document_attachments')
    .select(LANE_COLUMNS)
    .is('pages_read_at', null)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`fetch unread documents failed: ${error.message}`)
  for (const doc of (data ?? []) as ReadableDocumentRow[]) {
    const { outcome } = await readDocumentByPlan(supabase, doc, now)
    await tally(doc, outcome ?? { status: 'skipped', reason: 'lane_done' })
  }

  const room = limit - counts.processed
  if (room <= 0 || !getAiStatus().configured) return counts
  const { data: retry, error: retryError } = await supabase
    .from('document_attachments')
    .select(LANE_COLUMNS)
    .in('read_error', RETRY_REASONS)
    .order('pages_read_at', { ascending: true })
    .limit(room * 4)
  if (retryError) throw new Error(`fetch retry documents failed: ${retryError.message}`)
  // Vision pages already spent today per company, read once and kept as the pass spends more.
  const spent = new Map<string, number>()
  const roomToday = async (companyId: string): Promise<number> => {
    if (budget <= 0) return 0
    if (!spent.has(companyId)) {
      const { data: rows } = await supabase
        .from('arkiv_usage_daily')
        .select('units')
        .eq('company_id', companyId)
        .eq('activity', 'pages_vision')
        .eq('day', now.toISOString().slice(0, 10))
        .maybeSingle()
      spent.set(companyId, Number((rows as { units?: number } | null)?.units ?? 0))
    }
    return budget - (spent.get(companyId) ?? 0)
  }
  let taken = 0
  for (const doc of (retry ?? []) as ReadableDocumentRow[]) {
    if (taken >= room) break
    if (!doc.company_id || !isArkivEnabled(doc.company_id)) continue
    const lane = readLaneFor(doc, now)
    let plan: { allowModel: boolean; maxModelPages: number | null } | null = null
    if (lane === 'live') plan = { allowModel: true, maxModelPages: null }
    else if (lane === 'history_loose') plan = !doc.doc_type ? { allowModel: true, maxModelPages: 1 } : isActingType(doc.doc_type) ? { allowModel: true, maxModelPages: null } : null
    else if ((await roomToday(doc.company_id)) > 0) plan = { allowModel: true, maxModelPages: null }
    if (!plan) continue
    taken++
    const out = await readAndStoreDocument(supabase, doc, plan)
    await tally(doc, out)
    if (lane === 'history_tied' && out.status === 'read') spent.set(doc.company_id, (spent.get(doc.company_id) ?? 0) + out.pages)
  }
  return counts
}
