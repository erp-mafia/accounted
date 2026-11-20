/**
 * Which upload a screen uses for an underlag it attaches itself (a receipt
 * on an utlägg, the underlag on a new leverantörsfaktura).
 *
 * The document inbox reads the file with AI and is a paid service: the
 * extension dispatcher refuses every one of its routes for a company without
 * the AI capability (EXTENSION_REQUIRED_CAPABILITY). Attaching a file needs
 * no reading, and POST /api/documents stores it for any company, so the
 * screen picks the plain upload up front instead of sending a request that
 * is refused (for #206).
 */

export type UnderlagUploadRoute = 'inbox' | 'documents'

export const PLAIN_DOCUMENT_UPLOAD_URL = '/api/documents'

export function underlagUploadRoute(input: { hasAiCapability: boolean }): UnderlagUploadRoute {
  return input.hasAiCapability ? 'inbox' : 'documents'
}

/**
 * The form POST /api/documents expects for a file the person picked, minus
 * the file itself (postDocumentForm adds it, inline or staged in Storage).
 */
export function plainDocumentUploadForm(): FormData {
  const form = new FormData()
  form.append('upload_source', 'file_upload')
  return form
}

/** The stored document's id from a POST /api/documents answer, or null. */
export function documentIdFromPlainUpload(json: unknown): string | null {
  if (!json || typeof json !== 'object') return null
  const body = json as { data?: { id?: unknown } | null; error?: unknown }
  if (body.error) return null
  const id = body.data?.id
  return typeof id === 'string' && id.length > 0 ? id : null
}
