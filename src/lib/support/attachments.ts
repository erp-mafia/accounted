/**
 * Support attachment rules, shared by the dialog and the /api/support/contact
 * route so the client never offers to send something the server will reject.
 *
 * Attachments ride along on the existing support email. This module only
 * defines the transport limits and does not add a storage path.
 */

/** What a support reader can actually open without extra tooling. */
export const SUPPORT_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

const SUPPORT_ATTACHMENT_EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'application/pdf': '.pdf',
}

export const SUPPORT_MAX_ATTACHMENTS = 5

/**
 * Total bytes across all attachments in one message.
 *
 * Vercel rejects a request body over 4.5 MB before the function runs (see
 * lib/documents/upload-size.ts), so the ceiling has to leave room for the
 * multipart envelope and the message text on top of the files themselves.
 * Self-hosted has no such proxy limit, but the same cap applies there: a
 * support mailbox is not a file transfer service.
 */
export const SUPPORT_MAX_ATTACHMENT_TOTAL_MB = 4
export const SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES = SUPPORT_MAX_ATTACHMENT_TOTAL_MB * 1024 * 1024

export function isSupportedAttachmentType(type: string | null | undefined): boolean {
  return (SUPPORT_ATTACHMENT_TYPES as readonly string[]).includes(String(type ?? '').toLowerCase())
}

/** The `accept` attribute for the file picker: same list, one source of truth. */
export const SUPPORT_ATTACHMENT_ACCEPT = SUPPORT_ATTACHMENT_TYPES.join(',')

/**
 * Make a client-supplied name safe to put in a mail header: no path
 * separators, no control characters, bounded length. The extension is kept
 * when there is one so the attachment still opens with the right app.
 *
 * Control characters are stripped by code point rather than by a regex class:
 * a literal control character in a source file is invisible in review and has
 * corrupted this repo's files before.
 */
export function sanitizeAttachmentFilename(raw: string | undefined | null): string {
  const base = (String(raw ?? '').split(/[\\/]/).pop() ?? '')
    .split('')
    .filter((ch) => {
      const code = ch.charCodeAt(0)
      return code >= 0x20 && code !== 0x7f
    })
    .join('')
    .trim()

  if (!base) return 'bilaga'
  return base.length > 100 ? `${base.slice(0, 80)}-${base.slice(-16)}` : base
}

/**
 * Give the mail attachment an extension that agrees with the verified MIME
 * type. A browser-supplied name must not make a PDF look executable.
 */
export function supportAttachmentFilename(
  raw: string | undefined | null,
  type: string
): string {
  const safe = sanitizeAttachmentFilename(raw)
  const extension = SUPPORT_ATTACHMENT_EXTENSIONS[type.toLowerCase()] ?? '.bin'
  const lastDot = safe.lastIndexOf('.')
  const stem = (lastDot > 0 ? safe.slice(0, lastDot) : safe) || 'bilaga'
  return `${stem.slice(0, 100 - extension.length)}${extension}`
}
