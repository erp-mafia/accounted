import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiTier } from '@/lib/ai/types'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { getAiStatus } from '@/lib/ai'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { createLogger } from '@/lib/logger'
import { recordArkivUsage } from '@/lib/arkiv/usage'
import { readDocumentBytes } from './router'
import { historyReaderTier, readLaneFor, readPlanFor, isActingType, type ReadPlan } from './lanes'
import { READER_UNAVAILABLE, ReaderUnavailableError, readerForMime, type ReadOutcome } from './types'

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
// The lane columns of document_attachments (ReadableDocumentRow). Written out at every select so the schema guard can check them.

export type StoreOutcome =
  | { status: 'read'; pages: number; reader: string; partial?: string }
  | { status: 'skipped'; reason: string }
  | { status: 'error'; reason: string }

export const isReaderUnavailable = (out: StoreOutcome) => out.status === 'error' && out.reason.startsWith(READER_UNAVAILABLE)

/** Reasons the backfill retries later: the model was gated or unconfigured when the row was read. */
const RETRY_REASONS = ['ai_gated', 'ai_unconfigured', 'partial:ai_gated', 'partial:ai_unconfigured', 'partial:budget']

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
  opts: { allowModel?: boolean; maxModelPages?: number | null; tier?: AiTier } = {},
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
    outcome = await readDocumentBytes(bytes, doc.mime_type, { allowModel, maxModelPages: opts.maxModelPages ?? null, ...(opts.tier ? { tier: opts.tier } : {}) })
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
    text: storableText(p.text),
    words: p.words ? p.words.map((w) => ({ ...w, t: storableText(w.t) })) : null,
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

/**
 * What a reader found, made storable. Postgres holds no NUL in text and
 * rejects it (and an unpaired surrogate) inside jsonb with "unsupported
 * Unicode escape sequence"; some PDFs carry both in their text layer. Other
 * control characters go too: they are never content. Tabs and newlines stay.
 */
export function storableText(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD')
}

/** The lane's plan for this document now: null when nothing more is read up front. */
export function planForDocument(doc: ReadableDocumentRow, now = new Date()): ReadPlan | null {
  return readPlanFor({ lane: readLaneFor(doc, now), inRollout: isArkivEnabled(doc.company_id), docType: doc.doc_type ?? null, pagesRead: !!doc.pages_read_at })
}

/** Read what the lane says to read. The runner and the backfill both come through here. */
export async function readDocumentByPlan(supabase: SupabaseClient, doc: ReadableDocumentRow, now = new Date()): Promise<{ plan: ReadPlan | null; outcome: StoreOutcome | null }> {
  const plan = planForDocument(doc, now)
  if (!plan) return { plan: null, outcome: null }
  return { plan, outcome: await readAndStoreDocument(supabase, doc, { allowModel: plan.allowModel, maxModelPages: plan.maxModelPages, tier: plan.tier }) }
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
 * Backfill, in the order someone is waiting and each document read by its
 * lane (phase 9f): unread documents of the companies in the rollout, then
 * their documents whose model pages were gated, unconfigured or over budget
 * last time (only when a model is configured, and for voucher-tied history
 * only while the company's daily page budget, ARKIV_BACKFILL_PAGES_PER_DAY,
 * has room), then the newest unread documents of everyone else, text layers
 * only. The platform holds far more unread files than one run reads, so
 * without that order a company switched on today waits behind every other
 * archive. budgetMs stops the batch between documents.
 */
export async function readUnreadDocuments(
  supabase: SupabaseClient,
  limit: number,
  opts: {
    budgetMs?: number
    budgetPagesPerDay?: number
    now?: Date
    onRead?: (doc: ReadableDocumentRow, outcome: Extract<StoreOutcome, { status: 'read' }>) => Promise<void>
  } = {},
): Promise<{ processed: number; read: number; skipped: number; errors: number }> {
  const now = opts.now ?? new Date()
  const budget = Math.max(0, Math.floor(opts.budgetPagesPerDay ?? 0))
  const counts = { processed: 0, read: 0, skipped: 0, errors: 0 }
  const startedAt = Date.now()
  const spentTime = () => counts.processed >= limit || (opts.budgetMs !== undefined && Date.now() - startedAt >= opts.budgetMs)
  const tally = async (doc: ReadableDocumentRow, out: StoreOutcome) => {
    counts.processed++
    if (out.status === 'read') {
      counts.read++
      // The caller queues what follows a read (the classification); the store stays free of the queue.
      if (opts.onRead) await opts.onRead(doc, out)
    } else if (out.status === 'skipped') counts.skipped++
    else counts.errors++
  }
  // False when the reader is missing: that fails every document the same way, so stop and try again next run.
  const walkByPlan = async (docs: ReadableDocumentRow[]): Promise<boolean> => {
    for (const doc of docs) {
      if (spentTime()) return true
      const { outcome } = await readDocumentByPlan(supabase, doc, now)
      const out = outcome ?? { status: 'skipped' as const, reason: 'lane_done' }
      await tally(doc, out)
      if (isReaderUnavailable(out)) return false
    }
    return true
  }
  // The shelf is on for every company: nobody goes first, and everyone's gated rows are retried under the budget.
  if (!spentTime() && getAiStatus().configured) {
    const room = limit - counts.processed
    const retry = supabase.from('document_attachments').select('id, company_id, storage_path, mime_type, created_at, journal_entry_id, journal_entry_line_id, doc_type, pages_read_at, read_error').in('read_error', RETRY_REASONS)
    const { data, error } = await retry.order('pages_read_at', { ascending: true }).limit(room * 4)
    if (error) throw new Error(`fetch retry documents failed: ${error.message}`)
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
    for (const doc of (data ?? []) as ReadableDocumentRow[]) {
      if (taken >= room || spentTime()) break
      if (!doc.company_id || !isArkivEnabled(doc.company_id)) continue
      const lane = readLaneFor(doc, now)
      const tier = historyReaderTier()
      let plan: { allowModel: boolean; maxModelPages: number | null; tier?: AiTier } | null = null
      if (lane === 'live') plan = { allowModel: true, maxModelPages: null }
      else if (lane === 'history_loose') plan = !doc.doc_type ? { allowModel: true, maxModelPages: 1, tier } : isActingType(doc.doc_type) ? { allowModel: true, maxModelPages: null, tier } : null
      else if ((await roomToday(doc.company_id)) > 0) plan = { allowModel: true, maxModelPages: null, tier }
      if (!plan) continue
      taken++
      const out = await readAndStoreDocument(supabase, doc, plan)
      await tally(doc, out)
      if (isReaderUnavailable(out)) return counts
      if (lane === 'history_tied' && out.status === 'read') spent.set(doc.company_id, (spent.get(doc.company_id) ?? 0) + out.pages)
    }
  }

  if (spentTime()) return counts
  const { data, error } = await supabase
    .from('document_attachments')
    .select('id, company_id, storage_path, mime_type, created_at, journal_entry_id, journal_entry_line_id, doc_type, pages_read_at, read_error')
    .is('pages_read_at', null)
    .order('created_at', { ascending: false })
    .limit(limit - counts.processed)
  if (error) throw new Error(`fetch unread documents failed: ${error.message}`)
  await walkByPlan((data ?? []) as ReadableDocumentRow[])
  return counts
}
