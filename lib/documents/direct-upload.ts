/**
 * Direct-to-storage upload for the document inbox (issue #1551).
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

const INBOX_ROUTE_BASE = '/api/extensions/ext/invoice-inbox'
export const INBOX_UPLOAD_CREATE_URL = `${INBOX_ROUTE_BASE}/upload/create`
export const INBOX_UPLOAD_COMPLETE_URL = `${INBOX_ROUTE_BASE}/upload/complete`

export interface DirectUploadOptions {
  /** Pre-match the new inbox item to a bank transaction (same as /upload). */
  matchedTransactionId?: string | null
  /** Bring-your-own-extraction opt-out (same as /upload's skip_extraction). */
  skipExtraction?: boolean
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

export async function uploadViaSignedUrl(
  file: File,
  options: DirectUploadOptions = {},
): Promise<Response> {
  // Wrapped rather than referenced: a detached `fetch` loses its receiver.
  const fetchImpl: typeof fetch = options.fetchImpl ?? ((input, init) => fetch(input, init))

  const createRes = await fetchImpl(INBOX_UPLOAD_CREATE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      file_name: file.name,
      mime_type: file.type,
      size_bytes: file.size,
    }),
  })
  if (!createRes.ok) return createRes

  const created = (await createRes.json()) as { data?: Partial<SignedUploadReservation> }
  const reservation = created.data
  if (!reservation?.upload_id || !reservation.upload_url) {
    throw new Error('Signed upload reservation is missing upload_id or upload_url')
  }

  const put = await fetchImpl(reservation.upload_url, {
    method: 'PUT',
    headers: { 'content-type': file.type, 'x-upsert': 'false' },
    body: file,
  })
  if (!put.ok) return storageRejectedResponse(put.status)

  return fetchImpl(INBOX_UPLOAD_COMPLETE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      upload_id: reservation.upload_id,
      file_name: file.name,
      mime_type: file.type,
      matched_transaction_id: options.matchedTransactionId ?? null,
      skip_extraction: options.skipExtraction === true,
    }),
  })
}
