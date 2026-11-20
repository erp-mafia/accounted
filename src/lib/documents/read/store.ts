import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiTier } from '@/lib/ai/types'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { getAiStatus } from '@/lib/ai'
import { withAiMeter } from '@/lib/ai/meter'
import { createLogger } from '@/lib/logger'
import { recordArkivUsage } from '@/lib/arkiv/usage'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { readDocumentBytes } from './router'
import { keptPreview } from '@/lib/documents/preview'
import { historyReaderTier, readLaneFor, readPlanFor, isActingType, isBooked, type ReadPlan } from './lanes'
import { READ_GAVE_UP, READ_GIVE_UP_AFTER, READ_RETRY_WAIT_MINUTES, READER_UNAVAILABLE, ReaderUnavailableError, readerForMime, type ReadOutcome } from './types'
import { AI_CALL_LIMIT_MS, currentAiDeadline, isRunDeadlineCut } from '@/lib/ai/call-limit'
import { aiCallLimitMs } from '@/lib/ai/config'
import { classifyExtractionError } from '@/lib/documents/inbox-extraction/extraction-failure'

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

/**
 * How many documents in a row the reader or its model provider may fail on before a backfill pass stops. One
 * failure says little: it may be that document (a scan too long for what was left of the run), and stopping on it
 * let the same document head every run while the ones behind it were never tried. Three in a row is the reader
 * missing or the provider down, which fails every document the same way: stop and try again next run.
 */
const UNAVAILABLE_IN_A_ROW = 3

/** Reasons the backfill retries later: the model was gated or unconfigured when the row was read. */
const RETRY_REASONS = ['ai_gated', 'ai_unconfigured', 'partial:ai_gated', 'partial:ai_unconfigured', 'partial:budget']

/**
 * Read one document and store its pages. Idempotent: pages for the document
 * are replaced, and pages_read_at is stamped on every outcome about the
 * document so the backfill moves on (read_error names why when no or only some
 * pages were produced). A reader that could not be loaded is an outcome about
 * the environment: nothing is stamped and the document stays unread. A
 * reading the model provider did not answer is not stamped either, but it is
 * counted, once per wait, and the document is given up on at the fifth in a
 * row (see noteUnanswered and giveUp).
 * Never touches the file itself. The model is called only for a document
 * that belongs to a company; text layers are read for everyone.
 */
export async function readAndStoreDocument(
  supabase: SupabaseClient,
  doc: ReadableDocumentRow,
  opts: { allowModel?: boolean; maxModelPages?: number | null; tier?: AiTier } = {},
): Promise<StoreOutcome> {
  const allowModel = opts.allowModel ?? !!doc.company_id
  if (!doc.company_id) return stamp(supabase, doc.id, { status: 'skipped', reason: 'no_company' }, null)
  const kind = readerForMime(doc.mime_type)
  if (kind === null) return stamp(supabase, doc.id, { status: 'skipped', reason: 'unsupported_mime' }, null)
  if (kind === 'structured') return stamp(supabase, doc.id, { status: 'skipped', reason: 'structured' }, null)

  // A photo the viewer already sized is read from that JPEG: no second HEIC decode, no second resize.
  const preview = kind === 'claude_vision' ? await keptPreview(supabase, { id: doc.id, company_id: doc.company_id }) : null
  let bytes: Buffer
  let mime = doc.mime_type
  if (preview) {
    bytes = preview
    mime = 'image/jpeg'
  } else {
    const { blob, error } = await downloadDocumentObject(supabase, doc.storage_path, doc.company_id)
    if (error || !blob) {
      const reason = `download_failed: ${error?.message ?? 'no data'}`
      // The stored file could not be fetched: a storage fault, or an archived document whose object is gone. It was
      // stamped without a word, so nobody knew the document had no text. Stamped still, so the backfill moves on,
      // and reported once: a retry of the same failure (the job's later attempts) only warns.
      const fields = { doc: doc.id, company: doc.company_id, storagePath: doc.storage_path, reason }
      if (doc.read_error?.startsWith('download_failed')) log.warn('document file could not be downloaded, again', fields)
      else log.error('document file could not be downloaded, left without page text', fields)
      return stamp(supabase, doc.id, { status: 'error', reason }, null)
    }
    bytes = Buffer.from(await blob.arrayBuffer())
  }

  // What the reading has of its run when it starts: all of it, unless the run has a stop for its model calls.
  const modelStop = currentAiDeadline()
  const timeAtStart = modelStop === undefined ? Infinity : modelStop - Date.now()
  let outcome: ReadOutcome
  try {
    outcome = await withAiMeter({ feature: 'document_read', companyId: doc.company_id }, () =>
      readDocumentBytes(bytes, mime, { allowModel, maxModelPages: opts.maxModelPages ?? null, ...(opts.tier ? { tier: opts.tier } : {}) }),
    )
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    const readerMissing = err instanceof ReaderUnavailableError
    if (readerMissing || classifyExtractionError(err) === 'provider_unavailable') {
      // Not stamped: the document is fine, the reader is missing or its model provider is down (a Bedrock 503
      // stamped read_failed left 75 documents unread for good, seen 2026-10-19..26). It stays unread for the next run.
      // Counted, though, when it was the provider: see noteUnanswered. Not counted: a reader that could not be
      // loaded (the deployment's fault, the same for every document), and a reading the run's stop cut before it
      // had the time one model call gets (it started too late to say anything about the document). That time is
      // the deployment's limit, but never more than the default two minutes: a self-host that raised its limit past
      // what a run has would otherwise never count a cut, and a scan too long for a run would be read every run.
      const startedLate = isRunDeadlineCut(err) && timeAtStart < Math.min(aiCallLimitMs(), AI_CALL_LIMIT_MS)
      const unanswered = readerMissing || startedLate ? null : await noteUnanswered(supabase, doc.id)
      // Given up only by the reading that counted the fifth (or a later one, a day apart): never by a retry inside a wait.
      if (unanswered?.counted && unanswered.failures >= READ_GIVE_UP_AFTER) {
        const gaveUp = await giveUp(supabase, doc, unanswered.failures, reason)
        if (gaveUp) return gaveUp
      }
      log.warn('reader unavailable, document left unread', { doc: doc.id, mime: doc.mime_type, reason, ...(unanswered ? { unanswered: unanswered.failures, counted: unanswered.counted } : {}) })
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
 * One more reading of this document that the model provider did not answer:
 * how many there are in a row, and whether this one counted. Null when it
 * could not be recorded.
 *
 * A reading without an answer is tried again, and nothing used to count the
 * tries: a scan too long to read inside one run (the recent lane has no page
 * cap, the model reads three pages at a time) was read from the start every
 * five minutes for as long as it existed, each run spending what the model
 * read before the cut. The database keeps the count and when the next try
 * may start (note_document_read_unavailable, migration 20261112152731), and
 * counts a failure only once the last wait is over: the upload screen retries
 * a failed read every 1.5 s, and a one-minute provider burst must not add up
 * to five. The backfill's candidates leave the document out until then.
 *
 * Null, and the document is left exactly as before, when the count cannot be
 * kept: the function is not there yet (code ships before its migration), the
 * client is not the service role, or the row refuses the update (a document
 * on a locked period, which the backfill never takes anyway).
 */
async function noteUnanswered(supabase: SupabaseClient, documentId: string): Promise<{ failures: number; counted: boolean } | null> {
  const { data, error } = await supabase.rpc('note_document_read_unavailable', {
    p_document_id: documentId,
    p_backoff_minutes: READ_RETRY_WAIT_MINUTES,
  })
  if (error) {
    log.warn('unanswered reading not counted', { doc: documentId, reason: error.message })
    return null
  }
  const row = (Array.isArray(data) ? data[0] : data) as { failures?: unknown; counted?: unknown } | null | undefined
  return row && typeof row.failures === 'number' ? { failures: row.failures, counted: row.counted === true } : null
}

/**
 * The document got no answer READ_GIVE_UP_AFTER readings in a row, at least
 * 7.5 hours apart in all: not the provider having a bad hour, but this
 * document (too long to read inside one run, or one the provider fails on
 * every time). read_error says so, and the next try waits a day (the fifth
 * wait). Its pages_read_at stays NULL, so it is still an unread document:
 * the backfill takes it again once the day is over, and a question or an
 * agent asking for its text reads it at once; a reading that gets an answer
 * stamps it read like any other.
 *
 * Only a document nothing has been read from: the write is conditional on
 * pages_read_at still being NULL, so a document a pass already stored pages
 * for is never marked failed, and a reading that landed meanwhile wins.
 * Null when nothing was written. Reported once, when the document is first
 * given up on; a later daily try that fails again only warns, and writes
 * nothing: the mark is there already, and writing the same value again would
 * add an audit row a day for every such document. It only checks that no
 * reading landed meanwhile.
 */
async function giveUp(supabase: SupabaseClient, doc: ReadableDocumentRow, failures: number, reason: string): Promise<StoreOutcome | null> {
  if (doc.pages_read_at) return null
  const rows = supabase.from('document_attachments')
  const { data, error } = doc.read_error === READ_GAVE_UP
    ? await rows.select('id').eq('id', doc.id).is('pages_read_at', null)
    : await rows.update({ read_error: READ_GAVE_UP }).eq('id', doc.id).is('pages_read_at', null).select('id')
  if (error) {
    log.warn('give-up not recorded', { doc: doc.id, reason: error.message })
    return null
  }
  if (!Array.isArray(data) || data.length === 0) return null
  const fields = { doc: doc.id, company: doc.company_id, mime: doc.mime_type, unanswered: failures, reason }
  if (doc.read_error === READ_GAVE_UP) log.warn('document given up on still gets no answer, tried again in a day', fields)
  else log.error('document could not be read and is given up on, tried again once a day', fields)
  return { status: 'error', reason: `${READ_GAVE_UP} after ${failures} readings without an answer: ${reason.slice(0, 220)}` }
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
  return readPlanFor({ lane: readLaneFor(doc, now), inRollout: !!doc.company_id, docType: doc.doc_type ?? null, pagesRead: !!doc.pages_read_at, tied: isBooked(doc) })
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
 * archive. No document is started at or after deadlineAt (epoch ms); the rest
 * stays unread for the next run.
 */
export async function readUnreadDocuments(
  supabase: SupabaseClient,
  limit: number,
  opts: {
    deadlineAt?: number
    budgetPagesPerDay?: number
    now?: Date
    onRead?: (doc: ReadableDocumentRow, outcome: Extract<StoreOutcome, { status: 'read' }>) => Promise<void>
  } = {},
): Promise<{ processed: number; read: number; skipped: number; errors: number }> {
  const now = opts.now ?? new Date()
  const budget = Math.max(0, Math.floor(opts.budgetPagesPerDay ?? 0))
  const counts = { processed: 0, read: 0, skipped: 0, errors: 0 }
  const spentTime = () => counts.processed >= limit || (opts.deadlineAt !== undefined && Date.now() >= opts.deadlineAt)
  let unavailableInARow = 0
  // True once the reader or the provider has failed several documents in a row: the pass stops.
  const readerDown = () => unavailableInARow >= UNAVAILABLE_IN_A_ROW
  const tally = async (doc: ReadableDocumentRow, out: StoreOutcome) => {
    counts.processed++
    unavailableInARow = isReaderUnavailable(out) ? unavailableInARow + 1 : 0
    if (out.status === 'read') {
      counts.read++
      // The caller queues what follows a read (the classification); the store stays free of the queue.
      if (opts.onRead) await opts.onRead(doc, out)
    } else if (out.status === 'skipped') counts.skipped++
    else counts.errors++
  }
  const walkByPlan = async (docs: ReadableDocumentRow[]): Promise<void> => {
    for (const doc of docs) {
      if (spentTime() || readerDown()) return
      const plan = planForDocument(doc, now)
      // History costs the model only while the company has a budget; without one the backfill reads text layers and a question reads the rest.
      const out = plan
        ? await readAndStoreDocument(supabase, doc, { allowModel: plan.allowModel && (plan.lane === 'live' || budget > 0), maxModelPages: plan.maxModelPages, tier: plan.tier })
        : { status: 'skipped' as const, reason: 'lane_done' }
      await tally(doc, out)
    }
  }
  // The shelf is on for every company: nobody goes first, and everyone's gated rows are retried under the budget.
  if (!spentTime() && getAiStatus().configured) {
    const room = limit - counts.processed
    // Oldest stamp first, leaving out rows the stamp cannot land on: a gated document on a locked period was read
    // again with the model every run and led the next batch (seen 2026-09-24: 19 rows took every run's budget).
    const { data, error } = await supabase.rpc('document_retry_candidates', { p_reasons: RETRY_REASONS, p_limit: room * 4 })
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
          .eq('day', todayIsoStockholm(now))
          .maybeSingle()
        spent.set(companyId, Number((rows as { units?: number } | null)?.units ?? 0))
      }
      return budget - (spent.get(companyId) ?? 0)
    }
    let taken = 0
    for (const doc of (data ?? []) as ReadableDocumentRow[]) {
      if (taken >= room || spentTime()) break
      if (!doc.company_id) continue
      const lane = readLaneFor(doc, now)
      const tier = historyReaderTier()
      let plan: { allowModel: boolean; maxModelPages: number | null; tier?: AiTier } | null = null
      if (lane === 'live') plan = isBooked(doc) ? null : { allowModel: true, maxModelPages: null }
      else if ((await roomToday(doc.company_id)) <= 0) plan = null
      else if (lane === 'history_loose') plan = !doc.doc_type ? { allowModel: true, maxModelPages: 1, tier } : isActingType(doc.doc_type) ? { allowModel: true, maxModelPages: null, tier } : null
      else plan = { allowModel: true, maxModelPages: null, tier }
      if (!plan) continue
      taken++
      const out = await readAndStoreDocument(supabase, doc, plan)
      await tally(doc, out)
      if (readerDown()) return counts
      if (lane !== 'live' && out.status === 'read') spent.set(doc.company_id, (spent.get(doc.company_id) ?? 0) + out.pages)
    }
  }

  if (spentTime()) return counts
  // Only documents the stamp can land on: a bank response is never read, and a row on a locked period or an
  // archived reset source refuses the update, so it stayed the newest unread and was read again every run
  // (seen 2026-09-24: backlog reads down to 3 a day). Those are read when someone opens them.
  const { data, error } = await supabase.rpc('document_backfill_candidates', { p_limit: limit - counts.processed })
  if (error) throw new Error(`fetch unread documents failed: ${error.message}`)
  await walkByPlan((data ?? []) as ReadableDocumentRow[])
  return counts
}
