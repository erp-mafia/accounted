import { IMAGE_MIME_TYPES, OFFICE_MIME_TYPES } from '@/lib/documents/read/types'

/**
 * Chat intake accepts every document the pipe can read: photos and PDFs as
 * before, and since Arkiv phase 9e the office types too, so an agreement or
 * a letter sent over WhatsApp goes through the same door as a receipt and
 * lands where it belongs. HEIC never arrives (WhatsApp transcodes photos to
 * JPEG); audio, video and the rest get the M15 nudge.
 *
 * Kept as its own module with only pure constants behind it, because both
 * the deferred worker (the M15 rejection) and the webhook (the instant
 * checkmark reaction) gate on it, and tests that mock process-inbound must
 * not lose the constant.
 */
export const CHAT_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set(['application/pdf', ...IMAGE_MIME_TYPES, ...OFFICE_MIME_TYPES, 'text/plain'])

/** Normalize a raw MIME header value to what the allowlist stores. */
export function normalizeChatMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0].trim().toLowerCase()
}
