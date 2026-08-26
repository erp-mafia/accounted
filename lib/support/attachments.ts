/**
 * Support attachment rules, shared by the dialog and the /api/support/contact
 * route so the client never offers to send something the server will reject.
 *
 * Attachments ride along on the support email and are NOT written to the
 * document archive: a screenshot of a broken page is not rakenskapsinformation,
 * and putting it there would pull it into the 7-year retention rules.
 */

/** What a support reader can actually open without extra tooling. */
export const SUPPORT_ATTACHMENT_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'application/pdf',
] as const

export const SUPPORT_MAX_ATTACHMENTS = 3

/**
 * Total bytes across all attachments in one message.
 *
 * Vercel rejects a request body over 4.5 MB before the function runs (see
 * lib/documents/upload-size.ts), so the ceiling has to leave room for the
 * multipart envelope and the message text on top of the files themselves.
 * Self-hosted has no such proxy limit, but the same cap applies there: a
 * support mailbox is not a file transfer service.
 */
export const SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES = Math.round(3.5 * 1024 * 1024)

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
