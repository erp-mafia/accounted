/**
 * Direct-to-storage upload for documents too large for a hosted request body:
 * the document inbox (issue #1551, uploadViaSignedUrl) and every route that
 * reads its file through readUploadedFile (postDocumentForm, at the bottom).
 *
 * The platform rejects a request body over 4.5 MB before the route runs
 * (see upload-size.ts), and a PDF cannot be shrunk the way a photo can. This
 * path keeps the bytes out of the function body altogether:
 *
 *   1. POST /upload/create    mints a short-lived signed Storage URL
 *   2. PUT  <upload_url>      the browser sends the bytes straight to Storage
 *   3. POST /upload/complete  the server reads the object back out of Storage,
 *                             hashes it, archives it and runs the normal
 *                             inbox pipeline (extraction, inbox row)
 *
 * The hash is computed server-side from the stored object in step 3; nothing
 * the browser says about the content is trusted. The URL from step 1 is the
 * raw Storage URL on purpose: the same-origin /api/storage proxy the MCP
 * tools use buffers the body inside a function and would hit the same
 * ceiling.
 *
 * Resolves to the Response that ended the sequence: the /upload/complete
 * response on success (the same `{ data }` shape as the multipart /upload),
 * or the first failing step's response, so callers keep their existing
 * `if (!res.ok)` handling. A Storage rejection in step 2 is surfaced as a
 * synthesized error envelope carrying Storage's status, and step 3 is never
 * attempted after it: an abandoned reservation leaves no document row (the
 * pending object is swept on a later create).
 */

import { exceedsHostedUploadLimit } from '@/lib/documents/upload-size'

const INBOX_ROUTE_BASE = '/api/extensions/ext/invoice-inbox'
export const INBOX_UPLOAD_CREATE_URL = `${INBOX_ROUTE_BASE}/upload/create`
export const INBOX_UPLOAD_COMPLETE_URL = `${INBOX_ROUTE_BASE}/upload/complete`

export interface DirectUploadOptions {
  /** Injectable for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch
}

interface SignedUploadReservation {
  upload_id: string
  upload_url: string
  expires_at: string
}

/**
 * Storage answered the PUT with a failure. Wrapped in the standard envelope
 * so getResponseErrorMessage() reads it like any route failure. Never a
 * session-expiry false positive: notifySessionExpired keys on a header only
 * the app's own 401 carries.
 */
function storageRejectedResponse(status: number): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'INBOX_UPLOAD_STORAGE_REJECTED',
        message: `Lagringstjänsten tog inte emot filen (HTTP ${status}). Försök igen.`,
        message_en: `The storage service did not accept the file (HTTP ${status}). Try again.`,
      },
    }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

/**
 * The browser could not read the picked file, so nothing was sent. Same
 * envelope as a route refusal, so every caller shows the reason instead of
 * the "network error" a failed send would otherwise surface as.
 */
function fileUnreadableResponse(): Response {
  return new Response(
    JSON.stringify({
      error: {
        code: 'DOC_UPLOAD_FILE_UNREADABLE',
        message:
          'Webbläsaren kunde inte läsa filen från datorn, så den skickades aldrig. ' +
          'Spara en ny kopia av filen, till exempel på skrivbordet, och välj den igen.',
        message_en:
          'The browser could not read the file from your computer, so it was never sent. ' +
          'Save a new copy of the file, for example on the desktop, and choose it again.',
      },
    }),
    { status: 400, headers: { 'content-type': 'application/json' } },
  )
}

/**
 * The file's bytes held in memory, or null when the browser cannot read them.
 *
 * A picked File is a reference to a file on disk that fetch reads only while
 * it sends. When the browser cannot read it then (the file changed or moved
 * after it was picked, or sits in cloud storage not downloaded to the
 * computer), the request fails before it leaves the browser: nothing reaches
 * the server and the screen can only say "network error" (crm#1664). Read
 * here, the request carries bytes the browser already holds, and a file it
 * cannot read is named as such.
 */
async function readIntoMemory(file: File): Promise<File | null> {
  try {
    const bytes = await file.arrayBuffer()
    return new File([bytes], file.name, { type: file.type, lastModified: file.lastModified })
  } catch {
    // Not swallowed: null becomes the DOC_UPLOAD_FILE_UNREADABLE answer the
    // screen shows. The browser's own reason (NotReadableError and the like)
    // carries nothing the person can act on beyond picking the file again.
    return null
  }
}

/**
 * Steps 1 and 2: reserve at `createUrl` and PUT the bytes to the signed URL.
 * Resolves to the upload id, or to the Response that ended the sequence.
 */
async function stageInStorage(
  createUrl: string,
  file: File,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; uploadId: string } | { ok: false; response: Response }> {
  const createRes = await fetchImpl(createUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    }),
  })
  if (!createRes.ok) return { ok: false, response: createRes }

  const created = (await createRes.json()) as { data?: Partial<SignedUploadReservation> }
  const reservation = created.data
  if (!reservation?.upload_id || !reservation.upload_url) {
    throw new Error('Signed upload reservation is missing upload_id or upload_url')
  }

  const put = await fetchImpl(reservation.upload_url, {
    method: 'PUT',
    headers: { 'content-type': file.type || 'application/octet-stream', 'x-upsert': 'false' },
    body: file,
  })
  if (!put.ok) return { ok: false, response: storageRejectedResponse(put.status) }
  return { ok: true, uploadId: reservation.upload_id }
}

/** Wrapped rather than referenced: a detached `fetch` loses its receiver. */
function resolveFetch(options: DirectUploadOptions): typeof fetch {
  return options.fetchImpl ?? ((input, init) => fetch(input, init))
}

export async function uploadViaSignedUrl(
  file: File,
  options: DirectUploadOptions = {},
): Promise<Response> {
  const fetchImpl = resolveFetch(options)
  const staged = await stageInStorage(INBOX_UPLOAD_CREATE_URL, file, fetchImpl)
  if (!staged.ok) return staged.response

  return fetchImpl(INBOX_UPLOAD_COMPLETE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      upload_id: staged.uploadId,
      file_name: file.name,
      mime_type: file.type,
    }),
  })
}

export const DOCUMENT_UPLOAD_CREATE_URL = '/api/documents/uploads'

/**
 * POST a multipart form that carries one document file to a route that reads
 * it through readUploadedFile (POST /api/documents, POST
 * /api/documents/:id/versions, POST /api/import/documents/attach).
 *
 * A file that fits a hosted request body goes inline as `file`, as before. A
 * larger one goes straight to Storage first (POST /api/documents/uploads and a
 * PUT to the signed URL), and the form carries `upload_id`, `file_name` and
 * `mime_type` instead, so the route still gets the whole file and runs every
 * check it always ran. `form` holds the route's other fields.
 *
 * Same contract as uploadViaSignedUrl: resolves to the route's Response, or
 * to the first failing step's, so callers keep their `if (!res.ok)` handling.
 * A file the browser cannot read resolves to a DOC_UPLOAD_FILE_UNREADABLE
 * envelope and sends nothing (readIntoMemory).
 */
export async function postDocumentForm(
  url: string,
  form: FormData,
  picked: File,
  options: DirectUploadOptions = {},
): Promise<Response> {
  const fetchImpl = resolveFetch(options)
  const file = await readIntoMemory(picked)
  if (!file) return fileUnreadableResponse()
  if (!exceedsHostedUploadLimit(file.size)) {
    form.append('file', file)
    return fetchImpl(url, { method: 'POST', body: form })
  }

  const staged = await stageInStorage(DOCUMENT_UPLOAD_CREATE_URL, file, fetchImpl)
  if (!staged.ok) return staged.response
  form.append('upload_id', staged.uploadId)
  form.append('file_name', file.name)
  form.append('mime_type', file.type)
  return fetchImpl(url, { method: 'POST', body: form })
}
