/**
 * The file types a document upload accepts, and how a browser-declared type
 * is read. Pure and dependency-free on purpose: the server validation
 * (lib/core/documents/document-service.ts) and the browser drop zones import
 * the same list, so the picker can never offer a format the check refuses
 * (crm#268: DocumentUploadZone offered .csv and office files in its picker
 * but kept its own four-type list, so every CSV was refused before upload).
 */

/**
 * Office, OpenDocument, RTF and CSV documents (agreements, minutes, statements
 * arriving as files rather than PDFs). Read by the Arkiv reading layer
 * (lib/documents/read). Kept here, not imported from there, so this module
 * stays free of the reader's dependencies.
 */
export const OFFICE_DOCUMENT_TYPES = [
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
]

export const ALLOWED_DOCUMENT_TYPES = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  // The iPhone default. Verified by its ISO-BMFF brand like any other image,
  // read by the vision model after a decode, served to the viewer as JPEG.
  // Before 2026-09-24 the app's own drop zone refused it while the MCP and
  // the channels took it.
  'image/heic',
  'image/heif',
  ...OFFICE_DOCUMENT_TYPES,
]

/**
 * The type a file extension implies, for what a browser leaves blank or
 * generic: a HEIC arrives with no type or as application/octet-stream (prod,
 * 2026-09-24), and office files often do too on machines without the app.
 */
const EXTENSION_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  heic: 'image/heic',
  heif: 'image/heif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  doc: 'application/msword',
  xls: 'application/vnd.ms-excel',
  ppt: 'application/vnd.ms-powerpoint',
  odt: 'application/vnd.oasis.opendocument.text',
  ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation',
  rtf: 'application/rtf',
  csv: 'text/csv',
}

/**
 * What browsers declare for a .csv besides text/csv: Windows maps the
 * extension to Excel's type when Excel is installed, and some systems call it
 * plain text. The bytes are still CSV text, and the server's content check
 * for application/vnd.ms-excel expects an OLE binary, so the declared type is
 * corrected to text/csv instead of letting the check refuse a real CSV.
 */
const CSV_ALIASES = new Set(['application/vnd.ms-excel', 'text/plain', 'application/csv', 'text/x-csv', 'text/comma-separated-values'])

/** The input `accept` attribute that matches ALLOWED_DOCUMENT_TYPES. */
export const DOCUMENT_UPLOAD_ACCEPT = Object.keys(EXTENSION_TYPES).map((ext) => `.${ext}`).join(',')

function extensionOf(name: string | null | undefined): string {
  const lower = (name ?? '').toLowerCase()
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot + 1) : ''
}

/** The declared type, or the one the file extension implies when the browser declared none, only the generic one, or a known alias of CSV. */
export function declaredDocumentType(file: { name?: string | null; type?: string | null }): string {
  const ext = extensionOf(file.name)
  if (ext === 'csv' && (!file.type || file.type === 'application/octet-stream' || CSV_ALIASES.has(file.type))) {
    return 'text/csv'
  }
  if (file.type && file.type !== 'application/octet-stream') return file.type
  return EXTENSION_TYPES[ext] ?? file.type ?? ''
}

/** True when an upload of this file would pass the type allowlist. */
export function isAllowedDocumentFile(file: { name?: string | null; type?: string | null }): boolean {
  return ALLOWED_DOCUMENT_TYPES.includes(declaredDocumentType(file))
}
