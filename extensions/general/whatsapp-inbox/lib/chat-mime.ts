/**
 * Chat intake accepts what phones actually produce. Narrower than the upload
 * allowlist on purpose: WhatsApp transcodes photos to JPEG, so HEIC never
 * arrives, and everything else gets the M15 nudge.
 *
 * Lives in its own dependency-free module because both the deferred worker
 * (the M15 rejection) and the webhook (the instant checkmark reaction) gate
 * on it, and tests that mock process-inbound must not lose the constant.
 */
export const CHAT_ALLOWED_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
])

/** Normalize a raw MIME header value to what the allowlist stores. */
export function normalizeChatMime(mime: string | null | undefined): string {
  return (mime ?? '').split(';')[0].trim().toLowerCase()
}
