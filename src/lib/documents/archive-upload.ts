/**
 * Upload one picked file to the archive as a free-floating document: the one
 * definition of what Arkiv's own upload sends, shared by the Arkiv drop zone
 * and "Ladda upp för signering" on Signeringar.
 *
 * It is the plain POST /api/documents upload, never the document inbox's
 * route: the file is stored as an archived document and no inbox item is
 * filed at the door. Arkiv then types it on its own clock like every other
 * archived document, and what it is decides where it shows (a receipt or an
 * invoice is queued in Underlag, anything else stays a document in Arkiv).
 *
 * `dedupe_by_content` lets the route answer with the document already
 * archived when the same bytes are there and reached a verifikat or Underlag,
 * instead of storing a second copy (POST /api/documents).
 */
import { postDocumentForm, type DirectUploadOptions } from './direct-upload'
import { PLAIN_DOCUMENT_UPLOAD_URL, documentIdFromPlainUpload, plainDocumentUploadForm } from './underlag-upload-route'

export type ArchiveUploadResult =
  | {
      ok: true
      documentId: string
      /** The bytes were already in the archive: this is that document, nothing new was stored. */
      deduplicated: boolean
    }
  | {
      ok: false
      /** The HTTP status of the step that refused, 0 when nothing answered. */
      status: number
      /** The error envelope for getErrorMessage, or null when there was none to read. */
      body: unknown
    }

/** The form of a free-floating archive upload, minus the file itself (postDocumentForm adds it). */
export function archiveUploadForm(): FormData {
  const form = plainDocumentUploadForm()
  form.append('dedupe_by_content', 'true')
  return form
}

export async function uploadToArchive(file: File, options: DirectUploadOptions = {}): Promise<ArchiveUploadResult> {
  let response: Response
  try {
    response = await postDocumentForm(PLAIN_DOCUMENT_UPLOAD_URL, archiveUploadForm(), file, options)
  } catch {
    // Not swallowed: nothing answered (offline, a dropped connection, a
    // reservation that came back incomplete), and that is what the caller is
    // told. Status 0 with no body makes its screen say the upload failed.
    return { ok: false, status: 0, body: null }
  }
  const body: unknown = await response.json().catch(() => null)
  const documentId = response.ok ? documentIdFromPlainUpload(body) : null
  if (!documentId) return { ok: false, status: response.status, body }
  const deduplicated = (body as { data?: { deduplicated?: unknown } }).data?.deduplicated === true
  return { ok: true, documentId, deduplicated }
}

/**
 * Whether sending the same file again can end differently: nothing answered
 * (status 0), the server failed (5xx) or the upload limit asked for a pause
 * (429). Any other refusal is about the file or the person, so the screen
 * offers another file instead of the same one again.
 */
export function isRetryableArchiveUploadFailure(status: number): boolean {
  return status === 0 || status === 429 || status >= 500
}
