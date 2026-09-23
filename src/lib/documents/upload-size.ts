/**
 * What the hosting platform will actually carry, as opposed to what the
 * upload routes say they accept.
 *
 * Vercel rejects a request body over 4.5 MB itself, before the function runs:
 * the caller gets a plain-text 413 (FUNCTION_PAYLOAD_TOO_LARGE) and nothing
 * reaches the route, so nothing lands in the function logs either. That is why
 * a user reporting "uploading from my phone just fails" was invisible in
 * production while every upload that did arrive returned 200. A phone photo
 * routinely exceeds it: iPhone JPEG capture ("Most Compatible") lands at
 * 4-12 MB, well over the route's own 10 MB promise that can never be reached
 * on hosted.
 *
 * Self-hosted Docker has no such proxy limit, so the route's own MAX_FILE_SIZE
 * governs there and none of this applies.
 */

import { isSelfHosted } from '@/lib/env/public-flags'

/** The platform's hard ceiling on a request body. */
export const HOSTED_REQUEST_BODY_LIMIT_BYTES = Math.round(4.5 * 1024 * 1024)

/**
 * The largest file we will put in a multipart body. Below the hard ceiling by
 * enough to cover the multipart envelope (boundaries, part headers, the file
 * name) so a file that just fits does not fail on the framing around it.
 */
export const HOSTED_MAX_UPLOAD_BYTES = 4 * 1024 * 1024

export function isHostedDeployment(): boolean {
  return !isSelfHosted()
}

/**
 * Image types a browser canvas can decode and re-encode. HEIC/HEIF are
 * included deliberately: Safari on iOS decodes them natively, and iOS is
 * exactly where the oversized photos come from. Elsewhere the decode throws
 * and the caller keeps the original, which then gets the honest size message
 * instead of a silent failure.
 */
const SHRINKABLE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/heic',
  'image/heif',
  'image/webp',
])

export function isShrinkableImage(type: string | null | undefined): boolean {
  return SHRINKABLE_IMAGE_TYPES.has(String(type ?? '').toLowerCase())
}

/** True when this file cannot be sent as-is on a hosted deployment. */
export function exceedsHostedUploadLimit(size: number): boolean {
  return isHostedDeployment() && size > HOSTED_MAX_UPLOAD_BYTES
}

export function formatMegabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB`
}

/**
 * The sentence for a file that is over the limit and cannot be shrunk (a PDF,
 * or an image the browser would not decode). Names both the actual size and
 * the ceiling: "too large" without either is the kind of message that sends a
 * user back to support rather than to a solution.
 *
 * Still the right message for the surfaces that post a multipart body
 * (ReconciliationUnderlag, support attachments). The document inbox no
 * longer refuses at this ceiling: see inboxTooLargeMessage.
 */
export function tooLargeMessage(size: number): string {
  return (
    `Filen är ${formatMegabytes(size)} och gränsen är ${formatMegabytes(HOSTED_MAX_UPLOAD_BYTES)}. ` +
    'Fotografera om kvittot, eller komprimera PDF:en, och försök igen.'
  )
}

/**
 * The document inbox's own ceiling: MAX_FILE_SIZE in the invoice-inbox
 * extension and MAX_DOCUMENT_SIZE in the document service, both 10 MB.
 * Mirrored here because core components must not import from extensions.
 *
 * Between HOSTED_MAX_UPLOAD_BYTES and this one, the inbox sends the bytes
 * straight to Storage through a signed URL (direct-upload.ts) so the
 * platform's body cap no longer decides what can be filed; this one still
 * does, on hosted and self-hosted alike.
 */
export const INBOX_MAX_UPLOAD_BYTES = 10 * 1024 * 1024

/** True when the file is over the inbox ceiling on any deployment. */
export function exceedsInboxUploadLimit(size: number): boolean {
  return size > INBOX_MAX_UPLOAD_BYTES
}

/**
 * The inbox's sentence for a file over its ceiling. Same shape as
 * tooLargeMessage (actual size, then the limit), but the limit it names is
 * the one that actually applies on that surface now.
 */
export function inboxTooLargeMessage(size: number): string {
  return (
    `Filen är ${formatMegabytes(size)} och gränsen för dokumentinkorgen är ${formatMegabytes(INBOX_MAX_UPLOAD_BYTES)}. ` +
    'Komprimera PDF:en, eller dela upp den, och försök igen.'
  )
}
