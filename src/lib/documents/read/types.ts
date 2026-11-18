import type { AiTier } from '@/lib/ai/types'

/**
 * Arkiv reading layer: every document gets
 * page text, read locally when a text layer exists and by the model otherwise.
 */

export type PageReader = 'pdf_text' | 'office' | 'claude_vision' | 'text' | 'html'

export interface WordBox {
  /** The word as printed. */
  t: string
  /** Box in PDF points, top-left origin, page space. */
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface ReadPage {
  pageNo: number
  text: string
  reader: PageReader
  hasTextLayer: boolean
  words?: WordBox[]
  pageWidth?: number
  pageHeight?: number
}

/** Why the model did not read every page: never configured, gated for the company, or the pass had a page cap (the history lanes). */
export type ModelSkipReason = 'ai_unconfigured' | 'ai_gated' | 'budget'

export type ReadOutcome =
  | {
      ok: true
      pages: ReadPage[]
      reader: PageReader
      pageCount: number
      /** Set when some pages needed the model and it was gated or unconfigured: the text pages are stored, the rest waits. */
      partial?: ModelSkipReason
    }
  /** Nothing to read: structured archives (XML, JSON), unknown binaries, an empty file, or a scan whose model is gated or unconfigured. */
  | { ok: false; skipped: 'structured' | 'unsupported_mime' | 'empty' | ModelSkipReason }

export interface ReadOptions {
  /** False for companies outside the Arkiv rollout: text layers are still read, the model is never called. */
  allowModel: boolean
  /** Pages the model may transcribe in this pass; null or absent is every page that needs it. Text layers are never capped. */
  maxModelPages?: number | null
  /** The model tier that transcribes; the extraction tier when absent. History lanes pass the cheap tier. */
  tier?: AiTier
}

/** MIME types the reading layer understands. Kept in one place so the upload allowlist and the router agree. */
export const OFFICE_MIME_TYPES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  'application/vnd.oasis.opendocument.text',
  'application/vnd.oasis.opendocument.spreadsheet',
  'application/vnd.oasis.opendocument.presentation',
  'application/rtf',
  'text/rtf',
  'text/csv',
] as const

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/heic', 'image/heif'] as const
/** Archived as-is, never read into pages: the file IS the structured record. */
export const STRUCTURED_MIME_TYPES = ['application/xml', 'text/xml', 'application/json'] as const
/**
 * PostgREST filter that keeps the structured archives (bank responses, XML
 * payloads) out of what Arkiv shows as documents: the first rollout company
 * had 468 bank JSON files listed as "unknown type" with a button to say what
 * they are. A null mime type stays in.
 */
export const NOT_STRUCTURED_MIME_FILTER = `mime_type.is.null,mime_type.not.in.(${STRUCTURED_MIME_TYPES.join(',')})`

export function readerForMime(mimeType: string | null | undefined): PageReader | 'structured' | null {
  if (!mimeType) return null
  if (mimeType === 'application/pdf') return 'pdf_text'
  if ((IMAGE_MIME_TYPES as readonly string[]).includes(mimeType)) return 'claude_vision'
  if ((OFFICE_MIME_TYPES as readonly string[]).includes(mimeType)) return 'office'
  if (mimeType === 'text/html' || mimeType === 'application/xhtml+xml') return 'html'
  if (mimeType === 'text/plain') return 'text'
  if ((STRUCTURED_MIME_TYPES as readonly string[]).includes(mimeType)) return 'structured'
  return null
}

/**
 * The reader itself could not be loaded (a native binding the runtime cannot
 * load, say: the first PDF reader's Linux build needed glibc 2.35 and
 * Vercel's Amazon Linux 2023 runtime has 2.34). That is a fact about the environment, never about
 * the document, so nothing is stamped on the document: it stays unread and
 * the backfill reads it once the reader is there.
 */
export class ReaderUnavailableError extends Error {
  constructor(reader: string, cause: unknown) {
    super(`${reader}: ${cause instanceof Error ? cause.message : String(cause)}`)
    this.name = 'ReaderUnavailableError'
  }
}

export const READER_UNAVAILABLE = 'reader_unavailable'

/**
 * Minutes to wait after the nth try in a row that the model provider did not
 * answer: 30, 60, 120, 240. One schedule for a queued job's attempts
 * (lib/documents/jobs/queue.ts) and for a document's readings
 * (read_retry_after, lib/documents/read/store.ts), so five tries span about
 * 7.5 hours either way: Bedrock 503 bursts outlasted the 30 minutes a short
 * schedule covers and killed 139 read and classify jobs in a week (prod
 * 2026-10-19..26).
 */
export const outageBackoffMinutes = (tries: number): number => Math.min(240, 30 * 2 ** Math.max(0, tries - 1))

/** Readings in a row without an answer after which a document is given up on: as many as a queued job has attempts. */
export const READ_GIVE_UP_AFTER = 5

/**
 * The wait after each reading in a row that got no answer, before the next
 * may start and count (read_retry_after, note_document_read_unavailable):
 * the queue's outage backoff for the first four, so five take at least 7.5
 * hours, then a day, so a document given up on is tried again once a day.
 */
export const READ_RETRY_WAIT_MINUTES = [1, 2, 3, 4].map(outageBackoffMinutes).concat(24 * 60)

/**
 * The read_error of a document given up on after READ_GIVE_UP_AFTER readings
 * without an answer, and the prefix of the outcome that says so. Its
 * pages_read_at stays NULL: the document is still unread, so the backfill
 * takes it again after its day's wait and a question reads it at once. The
 * job queue ends the document's read job on it instead of trying again.
 */
export const READ_GAVE_UP = 'read_failed: gave up'

/**
 * Prefix of a stored step failure the AI provider caused (classifyExtractionError
 * says 'provider_unavailable'), so the job queue can tell "wait for the
 * provider" from "this document is broken" once the error object is gone.
 */
export const PROVIDER_UNAVAILABLE = 'provider_unavailable'

