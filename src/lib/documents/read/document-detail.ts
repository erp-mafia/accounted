import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { DOCUMENT_TEXT_NOTICE, fenceDocumentText, fenceNullable } from '@/lib/arkiv/untrusted'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { readerForMime } from '@/lib/documents/read/types'
import { listArrivalsForOutputs, summariseArrivals, type ArrivalSummary } from '@/lib/intake/arrivals'

/**
 * Everything about one document an agent or an API client can ask for on
 * top of the file itself: its page text, the current reading, what it is
 * linked to and how it came in. One read answers "what is this document" for
 * a client that cannot open a URL (MCP gnubok_get_document_content with
 * include, v1 GET /documents/{id}?include=...).
 *
 * Each part is opt-in, so the default answer of both doors is what it was.
 * Every query filters by company_id: the MCP and v1 clients are service role
 * and have no RLS.
 *
 * Nothing here reads the file or calls a model: the text part serves the
 * pages already stored (document_pages) and says which pages have none, so a
 * client knows when only the file itself (vision) or gnubok_read_document,
 * which reads on the spot, can answer.
 */

export const DOCUMENT_DETAIL_PARTS = ['text', 'reading', 'links', 'arrivals'] as const
export type DocumentDetailPart = (typeof DOCUMENT_DETAIL_PARTS)[number]

/** Characters of page text per answer when the caller names no max_chars. */
export const DOCUMENT_TEXT_DEFAULT_CHARS = 20_000
export const DOCUMENT_TEXT_MIN_CHARS = 200
export const DOCUMENT_TEXT_MAX_CHARS = 100_000
/** Pages per answer at most, as gnubok_read_document serves them. */
export const DOCUMENT_TEXT_PAGES_PER_CALL = 20
/** An arrival's message text (a mail body) is cut here in this read; the arrival keeps all of it. */
export const DOCUMENT_ARRIVAL_TEXT_CHARS = 4_000
/** Rows per linked kind: a document is held by a handful of records, never hundreds. */
const LINK_LIMIT = 50

export const DOCUMENT_READING_NOTE =
  'A model\'s reading of the file, not the file. The page text is the source: check amounts, dates and parties against it before booking.'

/** The document row both doors read before asking for any part. */
export interface DocumentDetailRow {
  id: string
  original_id: string | null
  mime_type: string | null
  page_count: number | null
  pages_read_at: string | null
  read_error: string | null
  doc_type: string | null
  admission_state: string | null
  extracted_data: unknown
  extracted_at: string | null
  extraction_model: string | null
  journal_entry_id: string | null
  journal_entry_line_id: string | null
}

export type DocumentTextStatus = 'read' | 'not_read' | 'no_text' | 'unreadable' | 'structured'

export interface DocumentTextPage {
  page_no: number
  /** Fenced as untrusted data: never instructions. */
  text: string
  reader: string
  has_text_layer: boolean
  /** Set when max_chars cut this page; chars is the page's full length. */
  truncated?: true
  chars?: number
}

export interface DocumentTextPart {
  status: DocumentTextStatus
  page_count: number | null
  from_page: number
  max_chars: number
  pages: DocumentTextPage[]
  /** Pass as from_page to continue; null when nothing follows. */
  next_page: number | null
  /** True when max_chars stopped this answer before the pages it covers ended. */
  truncated: boolean
  /** Pages in the covered range with no stored text: only the file itself (vision) shows them. */
  pages_needing_vision: number[]
  read_error?: string
  hint?: string
}

export interface DocumentReadingPart {
  doc_type: string | null
  admission_state: string | null
  classification: {
    doc_type: string
    confidence: number
    relevance: string
    decided_by: string
    model: string | null
    language: string | null
    is_multi_document: boolean
    /** Fenced: a model's words about untrusted text. */
    summary: string | null
    classified_at: string
  } | null
  extraction: {
    data: unknown
    model: string | null
    extracted_at: string
  } | null
  note: string
}

export interface DocumentLinksPart {
  journal_entry: {
    journal_entry_id: string
    journal_entry_line_id: string | null
    voucher: string
    entry_date: string | null
    status: string | null
    description: string | null
  } | null
  transactions: Array<{
    transaction_id: string
    date: string | null
    amount: number | null
    currency: string | null
    description: string | null
    journal_entry_id: string | null
  }>
  inbox_items: Array<{
    inbox_item_id: string
    held_as: 'file' | 'peppol_xml'
    status: string | null
    source: string | null
    matched_transaction_id: string | null
    created_journal_entry_id: string | null
    created_supplier_invoice_id: string | null
  }>
  supplier_invoices: Array<{
    supplier_invoice_id: string
    supplier_invoice_number: string | null
    invoice_date: string | null
    status: string | null
    total: number | null
    currency: string | null
    registration_journal_entry_id: string | null
  }>
  expense_claims: Array<{
    expense_claim_id: string
    expense_date: string | null
    status: string | null
    amount_sek: number | null
    journal_entry_id: string | null
  }>
  /** Parties, agreements and assets the company brain tied the document to; absent outside the brain. */
  records?: Array<{ record_ref: string; basis: string; method: string }>
}

export type DocumentArrival = ArrivalSummary & { message_text_truncated?: true }

export interface DocumentDetail {
  text?: DocumentTextPart
  reading?: DocumentReadingPart
  links?: DocumentLinksPart
  arrivals?: DocumentArrival[]
  /** Present with any part that carries text from the file or its sender. */
  notice?: string
}

export interface DocumentDetailOptions {
  include: readonly DocumentDetailPart[]
  fromPage?: number
  maxChars?: number
  /** Signs arrival originals; the row reads above it are the authorization. */
  storageClient?: SupabaseClient
  rewriteUrl?: (url: string) => string
  /**
   * How this door names the file and a read on the spot, for the text
   * part's hint: MCP says signed_url and gnubok_read_document, v1 the
   * download endpoint.
   */
  hints?: { file: string; readNow?: string }
}

const DEFAULT_HINTS = { file: 'the file itself' }

/**
 * The parts named in `value`: an array (MCP) or a comma-separated string (a
 * query string). Unknown names come back in `invalid`, never silently dropped.
 */
export function parseDocumentDetailParts(value: unknown): { parts: DocumentDetailPart[]; invalid: string[] } {
  if (value === undefined || value === null || value === '') return { parts: [], invalid: [] }
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [value]
  const parts: DocumentDetailPart[] = []
  const invalid: string[] = []
  for (const entry of raw) {
    const name = typeof entry === 'string' ? entry.trim() : String(entry)
    if (!name) continue
    if ((DOCUMENT_DETAIL_PARTS as readonly string[]).includes(name)) {
      if (!parts.includes(name as DocumentDetailPart)) parts.push(name as DocumentDetailPart)
    } else {
      invalid.push(name)
    }
  }
  return { parts, invalid }
}

/** max_chars as asked, held inside the bounds; the answer says which value was used. */
export function clampDocumentTextChars(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DOCUMENT_TEXT_DEFAULT_CHARS
  return Math.min(DOCUMENT_TEXT_MAX_CHARS, Math.max(DOCUMENT_TEXT_MIN_CHARS, Math.floor(value)))
}

export async function readDocumentDetail(
  supabase: SupabaseClient,
  companyId: string,
  doc: DocumentDetailRow,
  options: DocumentDetailOptions,
): Promise<DocumentDetail> {
  const want = new Set(options.include)
  if (want.size === 0) return {}
  const [text, reading, links, arrivals] = await Promise.all([
    want.has('text')
      ? readTextPart(supabase, companyId, doc, {
          fromPage: Math.max(1, Math.floor(options.fromPage ?? 1)),
          maxChars: clampDocumentTextChars(options.maxChars),
          hints: options.hints ?? DEFAULT_HINTS,
        })
      : undefined,
    want.has('reading') ? readReadingPart(supabase, companyId, doc) : undefined,
    want.has('links') ? readLinksPart(supabase, companyId, doc) : undefined,
    want.has('arrivals') ? readArrivalsPart(supabase, companyId, doc, options) : undefined,
  ])
  return {
    ...(text ? { text } : {}),
    ...(reading ? { reading } : {}),
    ...(links ? { links } : {}),
    ...(arrivals ? { arrivals } : {}),
    ...(text || reading || arrivals ? { notice: DOCUMENT_TEXT_NOTICE } : {}),
  }
}

async function readTextPart(
  supabase: SupabaseClient,
  companyId: string,
  doc: DocumentDetailRow,
  { fromPage, maxChars, hints }: { fromPage: number; maxChars: number; hints: { file: string; readNow?: string } },
): Promise<DocumentTextPart> {
  const lastAsked = fromPage + DOCUMENT_TEXT_PAGES_PER_CALL - 1
  const { data, error } = await supabase
    .from('document_pages')
    .select('page_no, text, reader, has_text_layer')
    .eq('company_id', companyId)
    .eq('document_id', doc.id)
    .gte('page_no', fromPage)
    .lte('page_no', lastAsked)
    .order('page_no', { ascending: true })
  if (error) throw dbError(error)
  const rows = ((data ?? []) as Array<{ page_no: number; text: string | null; reader: string; has_text_layer: boolean }>)
    .filter((row) => (row.text ?? '').length > 0)

  // Whole pages until the budget runs out; the first page is always served,
  // cut at max_chars when it alone is longer.
  const pages: DocumentTextPage[] = []
  let used = 0
  let stoppedAt: number | null = null
  for (const row of rows) {
    const full = row.text ?? ''
    const room = maxChars - used
    if (pages.length > 0 && full.length > room) {
      stoppedAt = row.page_no
      break
    }
    const cut = full.length > room
    const text = cut ? full.slice(0, room) : full
    pages.push({
      page_no: row.page_no,
      text: fenceDocumentText(text, { page: row.page_no }),
      reader: row.reader,
      has_text_layer: row.has_text_layer === true,
      ...(cut ? { truncated: true as const, chars: full.length } : {}),
    })
    used += text.length
    if (cut) break
  }

  const pageCount = doc.page_count
  const lastServed = pages.length > 0 ? pages[pages.length - 1].page_no : null
  const pageCut = pages.some((p) => p.truncated)
  // The range this answer speaks for: up to the page the budget stopped
  // before, else every page asked that the document has.
  const lastStored = rows.length > 0 ? rows[rows.length - 1].page_no : null
  const coveredTo =
    stoppedAt !== null
      ? stoppedAt - 1
      : pageCut && lastServed !== null
        ? lastServed
        : pageCount !== null
          ? Math.min(lastAsked, pageCount)
          : (lastStored ?? fromPage - 1)
  const served = new Set(pages.map((p) => p.page_no))
  const pagesNeedingVision: number[] = []
  for (let n = fromPage; n <= coveredTo; n++) if (!served.has(n)) pagesNeedingVision.push(n)

  const more = pageCount !== null ? coveredTo < pageCount : stoppedAt !== null || lastStored === lastAsked
  const nextPage = more ? coveredTo + 1 : null

  const structured = readerForMime(doc.mime_type) === 'structured'
  const status: DocumentTextStatus =
    pages.length > 0
      ? 'read'
      : structured
        ? 'structured'
        : doc.read_error
          ? 'unreadable'
          : !doc.pages_read_at
            ? 'not_read'
            : 'no_text'
  const hint =
    status === 'not_read'
      ? `Not read yet: open ${hints.file} with vision${hints.readNow ? `, or ${hints.readNow}` : ''}.`
      : status === 'structured'
        ? `A structured file (XML or JSON): its content is ${hints.file}.`
        : status === 'unreadable' || status === 'no_text'
          ? `No stored text on these pages: open ${hints.file} with vision.`
          : pagesNeedingVision.length > 0
            ? `Some pages have no stored text (pages_needing_vision): open ${hints.file} with vision for those.`
            : undefined

  return {
    status,
    page_count: pageCount,
    from_page: fromPage,
    max_chars: maxChars,
    pages,
    next_page: nextPage,
    truncated: stoppedAt !== null || pageCut,
    pages_needing_vision: pagesNeedingVision,
    ...(status === 'unreadable' && doc.read_error ? { read_error: doc.read_error } : {}),
    ...(hint ? { hint } : {}),
  }
}

async function readReadingPart(
  supabase: SupabaseClient,
  companyId: string,
  doc: DocumentDetailRow,
): Promise<DocumentReadingPart> {
  const { data, error } = await supabase
    .from('document_classifications')
    .select('doc_type, confidence, relevance, decided_by, model, language, is_multi_document, summary, created_at')
    .eq('company_id', companyId)
    .eq('document_id', doc.id)
    .eq('is_current', true)
    .maybeSingle()
  if (error) throw dbError(error)
  const c = data as {
    doc_type: string
    confidence: number
    relevance: string
    decided_by: string
    model: string | null
    language: string | null
    is_multi_document: boolean
    summary: string | null
    created_at: string
  } | null
  return {
    doc_type: doc.doc_type,
    admission_state: doc.admission_state,
    classification: c
      ? {
          doc_type: c.doc_type,
          confidence: Number(c.confidence),
          relevance: c.relevance,
          decided_by: c.decided_by,
          model: c.model,
          language: c.language,
          is_multi_document: c.is_multi_document === true,
          summary: fenceNullable(c.summary),
          classified_at: c.created_at,
        }
      : null,
    // Outside the brain no extracted field is served, only what the document
    // is (decision 2026-09-24: agents read the text for what is in it).
    // extracted_at is stamped on every attempt; a failed one leaves the data null.
    extraction: isArkivBrainEnabled(companyId) && doc.extracted_at
      ? { data: doc.extracted_data ?? null, model: doc.extraction_model, extracted_at: doc.extracted_at }
      : null,
    note: DOCUMENT_READING_NOTE,
  }
}

function rowsOf<T>(result: { data: unknown; error: unknown }): T[] {
  if (result.error) throw dbError(result.error)
  return Array.isArray(result.data) ? (result.data as T[]) : []
}

const numberOrNull = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value))

async function readLinksPart(
  supabase: SupabaseClient,
  companyId: string,
  doc: DocumentDetailRow,
): Promise<DocumentLinksPart> {
  const brain = isArkivBrainEnabled(companyId)
  const none = Promise.resolve({ data: null, error: null })
  const [entry, transactions, inboxFile, inboxXml, supplierInvoices, expenseClaims, records] = await Promise.all([
    doc.journal_entry_id
      ? supabase
          .from('journal_entries')
          .select('id, voucher_series, voucher_number, entry_date, status, description')
          .eq('company_id', companyId)
          .eq('id', doc.journal_entry_id)
          .maybeSingle()
      : none,
    supabase
      .from('transactions')
      .select('id, date, amount, currency, description, journal_entry_id')
      .eq('company_id', companyId)
      .eq('document_id', doc.id)
      .limit(LINK_LIMIT),
    supabase
      .from('invoice_inbox_items')
      .select('id, status, source, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id')
      .eq('company_id', companyId)
      .eq('document_id', doc.id)
      .limit(LINK_LIMIT),
    supabase
      .from('invoice_inbox_items')
      .select('id, status, source, matched_transaction_id, created_journal_entry_id, created_supplier_invoice_id')
      .eq('company_id', companyId)
      .eq('channel_context->>peppol_xml_document_id', doc.id)
      .limit(LINK_LIMIT),
    supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, invoice_date, status, total, currency, registration_journal_entry_id')
      .eq('company_id', companyId)
      .eq('document_id', doc.id)
      .limit(LINK_LIMIT),
    supabase
      .from('expense_claims')
      .select('id, expense_date, status, amount_sek, journal_entry_id')
      .eq('company_id', companyId)
      .eq('document_id', doc.id)
      .limit(LINK_LIMIT),
    // Outside the brain no link it made is served (decision 2026-09-23).
    brain
      ? supabase
          .from('document_links')
          .select('target_kind, target_id, basis, method')
          .eq('company_id', companyId)
          .eq('document_id', doc.id)
          .is('retired_at', null)
          .limit(LINK_LIMIT)
      : none,
  ])
  if (entry.error) throw dbError(entry.error)
  const e = entry.data as {
    id: string
    voucher_series: string | null
    voucher_number: number | null
    entry_date: string | null
    status: string | null
    description: string | null
  } | null

  type InboxRow = {
    id: string
    status: string | null
    source: string | null
    matched_transaction_id: string | null
    created_journal_entry_id: string | null
    created_supplier_invoice_id: string | null
  }
  const inbox = (rows: InboxRow[], heldAs: 'file' | 'peppol_xml') =>
    rows.map((row) => ({
      inbox_item_id: row.id,
      held_as: heldAs,
      status: row.status,
      source: row.source,
      matched_transaction_id: row.matched_transaction_id,
      created_journal_entry_id: row.created_journal_entry_id,
      created_supplier_invoice_id: row.created_supplier_invoice_id,
    }))

  return {
    journal_entry: doc.journal_entry_id
      ? {
          journal_entry_id: doc.journal_entry_id,
          journal_entry_line_id: doc.journal_entry_line_id,
          voucher: e ? `${e.voucher_series ?? ''}${e.voucher_number ?? ''}` : '',
          entry_date: e?.entry_date ?? null,
          status: e?.status ?? null,
          description: e?.description ?? null,
        }
      : null,
    transactions: rowsOf<{ id: string; date: string | null; amount: unknown; currency: string | null; description: string | null; journal_entry_id: string | null }>(transactions).map((t) => ({
      transaction_id: t.id,
      date: t.date,
      amount: numberOrNull(t.amount),
      currency: t.currency,
      description: t.description,
      journal_entry_id: t.journal_entry_id,
    })),
    inbox_items: [...inbox(rowsOf<InboxRow>(inboxFile), 'file'), ...inbox(rowsOf<InboxRow>(inboxXml), 'peppol_xml')],
    supplier_invoices: rowsOf<{
      id: string
      supplier_invoice_number: string | null
      invoice_date: string | null
      status: string | null
      total: unknown
      currency: string | null
      registration_journal_entry_id: string | null
    }>(supplierInvoices).map((s) => ({
      supplier_invoice_id: s.id,
      supplier_invoice_number: s.supplier_invoice_number,
      invoice_date: s.invoice_date,
      status: s.status,
      total: numberOrNull(s.total),
      currency: s.currency,
      registration_journal_entry_id: s.registration_journal_entry_id,
    })),
    expense_claims: rowsOf<{ id: string; expense_date: string | null; status: string | null; amount_sek: unknown; journal_entry_id: string | null }>(expenseClaims).map((x) => ({
      expense_claim_id: x.id,
      expense_date: x.expense_date,
      status: x.status,
      amount_sek: numberOrNull(x.amount_sek),
      journal_entry_id: x.journal_entry_id,
    })),
    ...(brain
      ? {
          records: rowsOf<{ target_kind: string; target_id: string; basis: string; method: string }>(records).map((l) => ({
            record_ref: `${l.target_kind}:${l.target_id}`,
            basis: l.basis,
            method: l.method,
          })),
        }
      : {}),
  }
}

/**
 * How the document came in: the arrivals of this document and, for a later
 * version, of the first one (a new version replaces, it does not arrive),
 * as GET /api/documents/:id/arrivals answers them. A mail body is cut to
 * DOCUMENT_ARRIVAL_TEXT_CHARS here.
 */
async function readArrivalsPart(
  supabase: SupabaseClient,
  companyId: string,
  doc: DocumentDetailRow,
  options: DocumentDetailOptions,
): Promise<DocumentArrival[]> {
  const documentIds = [doc.id, ...(doc.original_id && doc.original_id !== doc.id ? [doc.original_id] : [])]
  const arrivals = await listArrivalsForOutputs(
    supabase,
    companyId,
    documentIds.map((id) => ({ kind: 'document' as const, id })),
  )
  const summaries = await summariseArrivals(arrivals, {
    storageClient: options.storageClient ?? supabase,
    rewriteUrl: options.rewriteUrl,
  })
  return summaries.map((arrival) =>
    arrival.message_text && arrival.message_text.length > DOCUMENT_ARRIVAL_TEXT_CHARS
      ? { ...arrival, message_text: arrival.message_text.slice(0, DOCUMENT_ARRIVAL_TEXT_CHARS), message_text_truncated: true as const }
      : arrival,
  )
}
