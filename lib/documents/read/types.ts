/**
 * Arkiv reading layer (dev_docs/arkiv_plan.md, phase 1): every document gets
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

export type ModelSkipReason = 'ai_unconfigured' | 'ai_gated'

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

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'] as const
export const TEXT_MIME_TYPES = ['text/plain', 'text/html', 'application/xhtml+xml'] as const
/** Archived as-is, never read into pages: the file IS the structured record. */
export const STRUCTURED_MIME_TYPES = ['application/xml', 'text/xml', 'application/json'] as const

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

