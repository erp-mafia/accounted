/**
 * The thin slice of the Gmail API the hunt needs: search, read headers, fetch
 * an attachment. Nothing here writes, because the granted scope cannot.
 */
import type { MailCandidate } from '@/lib/mail-search/service'

const API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Hits to consider per mailbox per purchase. */
export const MAX_RESULTS = 8

interface GmailHeader {
  name: string
  value: string
}

interface GmailPart {
  filename?: string
  mimeType?: string
  body?: { attachmentId?: string; size?: number }
  parts?: GmailPart[]
}

interface GmailMessage {
  id: string
  internalDate?: string
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

/** Attachment ids anywhere in the MIME tree, ignoring inline images. */
function collectAttachments(part: GmailPart | undefined, out: string[]): void {
  if (!part) return
  const id = part.body?.attachmentId
  const named = part.filename && part.filename.length > 0
  const isDocument =
    named &&
    !/^image\/(png|gif)$/i.test(part.mimeType ?? '') // inline logos, not receipts
  if (id && isDocument) out.push(id)
  for (const child of part.parts ?? []) collectAttachments(child, out)
}

async function gmailFetch<T>(accessToken: string, path: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Gmail ${response.status}: ${text.slice(0, 200)}`)
  }
  return (await response.json()) as T
}

export async function searchMessageIds(accessToken: string, query: string): Promise<string[]> {
  const params = new URLSearchParams({ q: query, maxResults: String(MAX_RESULTS) })
  const data = await gmailFetch<{ messages?: Array<{ id: string }> }>(
    accessToken,
    `/messages?${params.toString()}`,
  )
  return (data.messages ?? []).map((m) => m.id)
}

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
  const msg = await gmailFetch<GmailMessage>(accessToken, `/messages/${messageId}?format=full`)
  const attachmentIds: string[] = []
  collectAttachments(msg.payload, attachmentIds)

  return {
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
    attachmentIds,
    bodyIsReceipt: attachmentIds.length === 0,
  }
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
