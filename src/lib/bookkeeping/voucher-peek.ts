/**
 * The verifikat side panel (components/bookkeeping/VoucherPeek.tsx): which
 * click on a verifikat link opens it, and its two reads. Read-only: every
 * request here is a GET.
 */
import { fetchRattelseFlags } from '@/lib/bookkeeping/rattelse-flags'
import type { JournalEntry } from '@/types'

/** The fields of a click that decide whether it opens the panel. */
export interface PeekClick {
  button: number
  metaKey: boolean
  ctrlKey: boolean
  shiftKey: boolean
  altKey: boolean
  defaultPrevented: boolean
}

/**
 * Whether a click on a verifikat link opens the side panel instead of
 * following the link: only an unmodified primary-button click that nothing
 * has handled yet. Every other click stays the browser's own: cmd or ctrl
 * and the middle button open a tab, shift a window, alt a download.
 */
export function opensPeek(click: PeekClick): boolean {
  if (click.defaultPrevented || click.button !== 0) return false
  return !(click.metaKey || click.ctrlKey || click.shiftKey || click.altKey)
}

/** The verifikat page: where a peek link leads, and where the panel's own link goes. */
export function voucherPageHref(entryId: string): string {
  return `/bookkeeping/${entryId}`
}

/** How a read reaches the API: `fetch`, or a caller's wrapper carrying an abort signal. */
type PeekRequest = (url: string) => Promise<Response>

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

/** A journal entry as the read answers it, checked on the fields the panel cannot render without. */
function isJournalEntry(value: unknown): value is JournalEntry {
  if (!isRecord(value)) return false
  if (typeof value.id !== 'string' || typeof value.entry_date !== 'string') return false
  if (typeof value.status !== 'string' || typeof value.source_type !== 'string') return false
  return value.lines === undefined || Array.isArray(value.lines)
}

export type VoucherPeekRead =
  /** `corrected`: the verifikat carries an inline rättelse (the "Rättad" marker). */
  | { state: 'ready'; entry: JournalEntry; corrected: boolean }
  /** No such verifikat in the active company: nothing to retry. */
  | { state: 'missing' }
  | { state: 'failed' }

/**
 * The verifikat with its lines, and whether it has been corrected in place.
 * A rättelse flag that could not be read fails the whole read: a corrected
 * verifikat shown as untouched is the one wrong answer here.
 */
export async function readVoucherPeek(entryId: string, request: PeekRequest = fetch): Promise<VoucherPeekRead> {
  try {
    const [response, flags] = await Promise.all([
      request(`/api/bookkeeping/journal-entries/${encodeURIComponent(entryId)}`),
      fetchRattelseFlags([entryId], request),
    ])
    if (response.status === 404) return { state: 'missing' }
    if (!response.ok || flags.incomplete) return { state: 'failed' }
    const body: unknown = await response.json()
    const entry = isRecord(body) ? body.data : null
    if (!isJournalEntry(entry)) return { state: 'failed' }
    return { state: 'ready', entry, corrected: flags.corrected.has(entryId) }
  } catch {
    // Offline, an aborted request or a body that is not JSON: the panel says the read failed and offers a retry.
    return { state: 'failed' }
  }
}

/** A document the panel links to: a file on the verifikat, or the retained document of a supplier invoice it refers to. */
export type PeekDocument =
  | { id: string; source: 'entry'; fileName: string }
  | { id: string; source: 'supplier_invoice'; invoiceNumber: string | null }

export type VoucherPeekUnderlagRead =
  /** `none`: no document and no linked record either, which is when the verifikat page says no underlag is attached. */
  | { state: 'ready'; documents: PeekDocument[]; none: boolean }
  | { state: 'failed' }

interface LinkedRecord {
  type: string
  number: string | null
  documentId: string | null
}

/** The rows of the document list read; a row without an id or a file name is not a document the panel can link. */
function attachedDocumentsOf(body: unknown): PeekDocument[] {
  const rows: unknown[] = isRecord(body) && Array.isArray(body.data) ? body.data : []
  const documents: PeekDocument[] = []
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === 'string' && typeof row.file_name === 'string') {
      documents.push({ id: row.id, source: 'entry', fileName: row.file_name })
    }
  }
  return documents
}

/** The linked records of the references read. */
function linkedRecordsOf(body: unknown): LinkedRecord[] {
  const data = isRecord(body) ? body.data : null
  const rows: unknown[] = isRecord(data) && Array.isArray(data.references) ? data.references : []
  const records: LinkedRecord[] = []
  for (const row of rows) {
    if (!isRecord(row) || typeof row.type !== 'string') continue
    records.push({
      type: row.type,
      number: typeof row.number === 'string' ? row.number : null,
      documentId: typeof row.document_id === 'string' ? row.document_id : null,
    })
  }
  return records
}

/**
 * The linked records of a verifikat, or null when they cannot be read. Best
 * effort, as on the verifikat page: this read never fails the documents.
 */
async function readLinkedRecords(url: string, request: PeekRequest): Promise<LinkedRecord[] | null> {
  try {
    const response = await request(url)
    return response.ok ? linkedRecordsOf(await response.json()) : null
  } catch {
    // Offline, an aborted request or a body that is not JSON: the attached files still show, and nothing is said about "none".
    return null
  }
}

/**
 * The documents behind a verifikat, as the verifikat page lists them: the
 * files attached to it, then the retained document of each supplier invoice
 * it refers to (unless that file is already attached). The linked records
 * are best-effort, as on the page: when that read fails the attached files
 * still show, and `none` stays false because nothing can be said about it.
 */
export async function readVoucherPeekUnderlag(
  entryId: string,
  request: PeekRequest = fetch,
): Promise<VoucherPeekUnderlagRead> {
  const id = encodeURIComponent(entryId)
  try {
    const [documentsResponse, linked] = await Promise.all([
      request(`/api/documents?journal_entry_id=${id}&current_only=true`),
      readLinkedRecords(`/api/bookkeeping/journal-entries/${id}/references`, request),
    ])
    if (!documentsResponse.ok) return { state: 'failed' }
    const documents = attachedDocumentsOf(await documentsResponse.json())

    const listed = new Set(documents.map((document) => document.id))
    for (const record of linked ?? []) {
      if (record.type !== 'supplier_invoice' || !record.documentId || listed.has(record.documentId)) continue
      listed.add(record.documentId)
      documents.push({ id: record.documentId, source: 'supplier_invoice', invoiceNumber: record.number })
    }
    return { state: 'ready', documents, none: documents.length === 0 && linked !== null && linked.length === 0 }
  } catch {
    // Offline, an aborted request or a body that is not JSON: the section says the read failed and offers a retry.
    return { state: 'failed' }
  }
}
