/**
 * The thin slice of the Gmail API the hunt needs: search, read headers, fetch
 * an attachment. Nothing here writes, because the granted scope cannot.
 */
import type { MailCandidate } from '@/lib/mail-search/service'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/**
 * Deadline on every Gmail call.
 *
 * Mailboxes are searched with Promise.all, so one stalled request would hold
 * the whole company's hunt open until the platform killed the run. A timeout
 * turns that into one mailbox missing from tonight's sweep.
 */
export const GMAIL_TIMEOUT_MS = 15_000

/** Hits to consider per mailbox per purchase. */
export const MAX_RESULTS = 8

interface GmailHeader {
  name: string
  value: string
}

interface GmailPart {
  filename?: string
  mimeType?: string
  body?: { attachmentId?: string; size?: number; data?: string }
  parts?: GmailPart[]
}

/** Longest body worth carrying: a receipt states its total near the top. */
const MAX_BODY_CHARS = 2500

/**
 * The readable text of a mail.
 *
 * Already on the wire (format=full is required to see the parts tree at all),
 * so this costs nothing extra, and it is where the two facts a forwarded
 * receipt hides live: the original sender and the original date, both written
 * into the "Vidarebefordrat meddelande" header that Gmail's 200-character
 * snippet cuts off.
 */
function collectBodyText(part: GmailPart | undefined, out: string[]): void {
  if (!part) return
  const type = part.mimeType ?? ''
  if ((type === 'text/plain' || type === 'text/html') && part.body?.data) {
    out.push(Buffer.from(part.body.data, 'base64url').toString('utf8'))
  }
  for (const child of part.parts ?? []) collectBodyText(child, out)
}

function readableBody(msg: GmailMessage): string {
  const chunks: string[] = []
  collectBodyText(msg.payload, chunks)
  return chunks
    .join('\n')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&zwnj;|&#847;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_BODY_CHARS)
}

interface GmailMessage {
  id: string
  internalDate?: string
  snippet?: string
  payload?: {
    headers?: GmailHeader[]
    filename?: string
    mimeType?: string
    body?: { attachmentId?: string; size?: number }
    parts?: GmailPart[]
  }
}

function header(msg: GmailMessage, name: string): string | null {
  const found = msg.payload?.headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())
  return found?.value ?? null
}

/** Attachments anywhere in the MIME tree, ignoring inline images. */
function collectAttachments(
  part: GmailPart | undefined,
  out: Array<{ id: string; filename: string }>,
): void {
  if (!part) return
  const id = part.body?.attachmentId
  const named = part.filename && part.filename.length > 0
  const isDocument =
    named &&
    !/^image\/(png|gif)$/i.test(part.mimeType ?? '') // inline logos, not receipts
  if (id && isDocument) out.push({ id, filename: part.filename as string })
  for (const child of part.parts ?? []) collectAttachments(child, out)
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(GMAIL_TIMEOUT_MS),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Gmail ${response.status}: ${text.slice(0, 200)}`)
  }
  return (await response.json()) as T
}

/**
 * The address of the mailbox a token belongs to.
 *
 * Read from Gmail's own profile endpoint, which gmail.readonly covers, so the
 * consent flow never has to ask for `openid email` on top. The address is the
 * unique key of a connection: without it two grants for the same company
 * could not be told apart.
 */
export async function getMailboxAddress(accessToken: string): Promise<string | null> {
  const data = await gmailFetch<{ emailAddress?: string }>(accessToken, '/profile')
  const address = data.emailAddress?.trim()
  return address ? address : null
}

export async function searchMessageIds(
  accessToken: string,
  query: string,
  maxResults: number = MAX_RESULTS,
): Promise<string[]> {
  const params = new URLSearchParams({ q: query, maxResults: String(maxResults) })
  const data = await gmailFetch<{ messages?: Array<{ id: string }> }>(
    accessToken,
    `/messages?${params.toString()}`,
  )
  return (data.messages ?? []).map((m) => m.id)
}

/**
 * Messages already read, keyed by connection and id.
 *
 * A press searches many purchases across every mailbox, and one receipt mail
 * answers several of those queries, so the same message was being downloaded
 * dozens of times: 25 purchases against 2 mailboxes could ask for well over a
 * thousand fetches to end up with a hundred distinct mails. Deduplication
 * happened afterwards, which was too late to save the work.
 *
 * A mail's content never changes, so caching it needs no invalidation. The cap
 * is what keeps a long-lived server from growing without bound.
 */
const summaryCache = new Map<string, MailCandidate>()
const SUMMARY_CACHE_MAX = 1_000

/**
 * Subject, sender, date and which parts are attachments.
 *
 * `format=full` rather than `format=metadata`: metadata returns headers only
 * and omits `payload.parts` entirely, so every message came back looking like
 * it had no attachments and the hunt could never file anything. Gmail offers no
 * format that returns the MIME structure without the body, so the body does
 * come down the wire here. It is read for nothing and stored nowhere: only
 * attachment bytes are ever persisted, and only after a match.
 */
export async function getMessageSummary(
  accessToken: string,
  messageId: string,
  connectionId: string,
  mailbox: string,
): Promise<MailCandidate> {
  const cacheKey = `${connectionId}::${messageId}`
  const cached = summaryCache.get(cacheKey)
  if (cached) return cached

  const msg = await gmailFetch<GmailMessage>(accessToken, `/messages/${messageId}?format=full`)
  const attachments: Array<{ id: string; filename: string }> = []
  collectAttachments(msg.payload, attachments)

  const candidate: MailCandidate = {
    connectionId,
    mailbox,
    provider: 'gmail',
    messageId: msg.id,
    subject: header(msg, 'Subject'),
    from: header(msg, 'From'),
    receivedAt: msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : header(msg, 'Date'),
    // A receipt with no attachment is usually the mail body itself; the caller
    // decides whether to render it.
    attachmentIds: attachments.map((a) => a.id),
    attachmentNames: attachments.map((a) => a.filename),
    snippet: msg.snippet ?? null,
    bodyText: readableBody(msg),
    bodyIsReceipt: attachments.length === 0,
  }

  // Oldest out first: the working set of one press is what matters, and a
  // press that overflows the cap was going to refetch anyway.
  if (summaryCache.size >= SUMMARY_CACHE_MAX) {
    const oldest = summaryCache.keys().next().value
    if (oldest) summaryCache.delete(oldest)
  }
  summaryCache.set(cacheKey, candidate)
  return candidate
}

/** Drop everything read so far. Tests reuse message ids; production does not. */
export function clearMessageCache(): void {
  summaryCache.clear()
}

export async function fetchAttachmentBytes(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<Buffer | null> {
  const data = await gmailFetch<{ data?: string; size?: number }>(
    accessToken,
    `/messages/${messageId}/attachments/${attachmentId}`,
  )
  if (!data.data) return null
  return Buffer.from(data.data, 'base64url')
}

/**
 * Filename and MIME type live on the message, not on the attachment response,
 * so they are read back from the parts tree.
 */
export async function describeAttachment(
  accessToken: string,
  messageId: string,
  attachmentId: string,
): Promise<{ filename: string; mimeType: string } | null> {
  const msg = await gmailFetch<GmailMessage>(accessToken, `/messages/${messageId}?format=full`)
  let found: { filename: string; mimeType: string } | null = null
  const walk = (part: GmailPart | undefined): void => {
    if (!part || found) return
    if (part.body?.attachmentId === attachmentId) {
      found = {
        filename: part.filename || 'underlag.pdf',
        mimeType: part.mimeType || 'application/octet-stream',
      }
      return
    }
    for (const child of part.parts ?? []) walk(child)
  }
  walk(msg.payload)
  return found
}
