import { getResendClient } from '@/lib/email/resend-client'
import type { EmailReceivedEvent, GetReceivingEmailResponseSuccess, WebhookEventPayload } from 'resend'

export type ResendReceivedEmail = GetReceivingEmailResponseSuccess

export interface ResendAttachmentDownload {
  id: string
  filename: string
  contentType: string
  buffer: ArrayBuffer
}

export class ResendSignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResendSignatureError'
  }
}

// Verifies the Svix-signed webhook payload using the RESEND_INBOUND_WEBHOOK_SECRET.
// Throws ResendSignatureError on failure, returns the parsed event on success.
export function verifyInboundWebhook(rawBody: string, requestHeaders: Headers): WebhookEventPayload {
  const secret = process.env.RESEND_INBOUND_WEBHOOK_SECRET
  if (!secret) throw new Error('RESEND_INBOUND_WEBHOOK_SECRET is required')

  // Resend's verify() expects Svix headers in a specific shape, not the raw Fetch Headers.
  const svixHeaders = {
    id: requestHeaders.get('svix-id') ?? '',
    timestamp: requestHeaders.get('svix-timestamp') ?? '',
    signature: requestHeaders.get('svix-signature') ?? '',
  }

  const resend = getResendClient()
  try {
    return resend.webhooks.verify({ payload: rawBody, headers: svixHeaders, webhookSecret: secret })
  } catch (err) {
    throw new ResendSignatureError(err instanceof Error ? err.message : 'Invalid signature')
  }
}

// Fetches the full received email (body, headers, attachment metadata) by email_id.
// By default Resend rewrites the HTML's cid: image references to data: URIs;
// htmlFormat 'cid' keeps the references as received.
export async function fetchReceivingEmail(
  emailId: string,
  opts: { htmlFormat?: 'data_uri' | 'cid' } = {}
): Promise<ResendReceivedEmail> {
  const resend = getResendClient()
  const { data, error } = await resend.emails.receiving.get(emailId, { html_format: opts.htmlFormat })
  if (error || !data) {
    throw new Error(`Failed to fetch received email ${emailId}: ${error?.message ?? 'no data'}`)
  }
  return data
}

// Fetches a single attachment's bytes via its short-lived download_url.
export async function fetchInboundAttachment(
  emailId: string,
  attachmentId: string
): Promise<ResendAttachmentDownload> {
  const resend = getResendClient()
  const { data, error } = await resend.emails.receiving.attachments.get({ emailId, id: attachmentId })
  if (error || !data) {
    throw new Error(`Failed to fetch attachment ${attachmentId}: ${error?.message ?? 'no data'}`)
  }

  const response = await fetch(data.download_url)
  if (!response.ok) {
    throw new Error(`Download URL returned ${response.status} for attachment ${attachmentId}`)
  }
  const buffer = await response.arrayBuffer()

  return {
    id: data.id,
    filename: data.filename ?? `attachment-${data.id}`,
    contentType: data.content_type,
    buffer,
  }
}

export interface SharedInboxRecipient {
  /** The company_inboxes.local_part candidate, lowercased, without any +tag. */
  localPart: string
  /** Plus-address tag (the part after the first `+`), lowercased; null when absent or empty. */
  tag: string | null
}

// Parses every recipient whose domain matches our configured inbound domain,
// in original order, each split at the first `+` (RFC 5233 sub-addressing):
// `acme-x7f2+lev@inbox` matches the inbox row for `acme-x7f2` and carries
// tag `lev`. Duplicate addresses collapse to one entry. Returns all of them
// because one mail can name the same inbox twice with different tags, or two
// inboxes at once (#2181): reading only the first silently lost the rest.
export function extractSharedRecipientsForDomain(
  recipients: string[],
  domain: string,
): SharedInboxRecipient[] {
  const normalized = domain.toLowerCase()
  const seen = new Set<string>()
  const out: SharedInboxRecipient[] = []
  for (const addr of recipients) {
    const match = addr.match(/^\s*([^@\s]+)@([^@\s]+?)\s*$/)
    if (!match) continue
    const [, rawLocal, addrDomain] = match
    if (addrDomain.toLowerCase() !== normalized) continue
    const lower = rawLocal.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    const plus = lower.indexOf('+')
    if (plus === -1) {
      out.push({ localPart: lower, tag: null })
      continue
    }
    const tag = lower.slice(plus + 1)
    out.push({ localPart: lower.slice(0, plus), tag: tag.length > 0 ? tag : null })
  }
  return out
}

// The first shared-domain recipient, or null if no recipient is on the
// domain. Kept for callers that only need to know whether the mail is on
// the shared domain at all; the webhook reads every recipient.
export function extractLocalPartForDomain(
  recipients: string[],
  domain: string,
): SharedInboxRecipient | null {
  return extractSharedRecipientsForDomain(recipients, domain)[0] ?? null
}

/** Recipients grouped by inbox local part, tags in first-seen order. */
export interface SharedInboxTarget {
  localPart: string
  tags: string[]
}

export function groupSharedRecipientsByInbox(recipients: SharedInboxRecipient[]): SharedInboxTarget[] {
  const byLocalPart = new Map<string, string[]>()
  for (const r of recipients) {
    const tags = byLocalPart.get(r.localPart) ?? []
    if (r.tag !== null && !tags.includes(r.tag)) tags.push(r.tag)
    byLocalPart.set(r.localPart, tags)
  }
  return Array.from(byLocalPart, ([localPart, tags]) => ({ localPart, tags }))
}

/** Sender-declared document kind, stored on invoice_inbox_items.kind_hint. */
export type InboxKindHint = 'supplier_invoice' | 'receipt'

// Maps the plus-address tag to a kind hint. `+lev` (leverantörsfaktura) and
// `+ver` (verifikation/underlag) are the two documented tags; anything else
// routes to the inbox with no hint, so a typo never loses a document.
export function kindHintFromTag(tag: string | null | undefined): InboxKindHint | null {
  if (tag === 'lev') return 'supplier_invoice'
  if (tag === 'ver') return 'receipt'
  return null
}

/** The documented plus-address tags. Anything else is sender-typed free text. */
export const KNOWN_INBOX_TAGS: readonly string[] = ['lev', 'ver']

/**
 * Splits a mail's tags into the documented ones (safe to store: a closed
 * vocabulary) and a count of the rest. The rest is never stored: the part
 * after `+` is whatever the sender typed, and processing_history is
 * append-only and outside the erasure path (#2181 skeptic finding).
 */
export function splitKnownInboxTags(tags: readonly string[]): { known: string[]; unknownCount: number } {
  const known: string[] = []
  let unknownCount = 0
  for (const tag of tags) {
    if (KNOWN_INBOX_TAGS.includes(tag)) known.push(tag)
    else unknownCount += 1
  }
  return { known, unknownCount }
}

/**
 * The one kind hint for a mail that reached the same inbox under several
 * tags. Distinct documented tags contradict each other (+lev and +ver on one
 * mail, #2181): then the sender has said nothing usable, the hint is null so
 * extraction classifies, and `conflict` is recorded on the mail's history
 * event. Unknown tags never count.
 */
export function resolveKindHintForTags(tags: readonly string[]): {
  kindHint: InboxKindHint | null
  conflict: boolean
} {
  const hints = new Set<InboxKindHint>()
  for (const tag of tags) {
    const hint = kindHintFromTag(tag)
    if (hint) hints.add(hint)
  }
  if (hints.size > 1) return { kindHint: null, conflict: true }
  return { kindHint: hints.values().next().value ?? null, conflict: false }
}

export function isEmailReceivedEvent(event: WebhookEventPayload): event is EmailReceivedEvent {
  return event.type === 'email.received'
}

/**
 * How long a mail over the inbox's per-minute cap is handed back to Resend
 * instead of being dropped. Resend retries a failed delivery after 5 seconds,
 * 5 minutes, 30 minutes, 2 hours, 5 hours and 10 hours: inside the first hour
 * the next attempt lands after the minute window has turned, so a burst (an
 * agent forwarding 40 receipts in 20 seconds, crm#1783) comes in a few
 * minutes late instead of not at all. A mail still over the cap after that
 * belongs to a sustained flood: it is dropped and recorded as before, so it
 * ends in a record and the cap keeps bounding what a flood costs.
 */
export const MINUTE_CAP_REDELIVERY_WINDOW_MS = 60 * 60 * 1000

/**
 * Whether a mail Resend received at `receivedAt` may still be handed back for
 * redelivery. An unreadable time counts as too old: the drop is the outcome
 * that always leaves a record.
 */
export function mayRedeliverOverMinuteCap(receivedAt: string | null | undefined, now: number = Date.now()): boolean {
  const received = receivedAt ? Date.parse(receivedAt) : NaN
  if (!Number.isFinite(received)) return false
  return now - received < MINUTE_CAP_REDELIVERY_WINDOW_MS
}

/**
 * A text/plain part of a mail: its plain-text alternative, or a client's
 * ATT00001.txt. Never underlag the inbox takes, and next to any other part of
 * the same mail it says nothing that part does not.
 */
export function isPlainTextPart(contentType: string | null | undefined): boolean {
  return baseContentType(contentType) === 'text/plain'
}

/** A content type without its parameters, lowercased: "Text/Calendar; method=REQUEST" is "text/calendar". */
export function baseContentType(contentType: string | null | undefined): string {
  return String(contentType ?? '').split(';')[0].trim().toLowerCase()
}

/**
 * Parts a mail carries for the mail's own sake: a calendar invite, an S/MIME
 * or PGP signature and its key, a contact card, a delivery report. None is a
 * document in any form, so none can be underlag. A closed list on purpose:
 * a type the inbox merely does not take (a TIFF, a ZIP, an XML e-invoice) may
 * be the receipt in a format to send again, and keeps its rejection row.
 */
const MAIL_MACHINERY_TYPES: ReadonlySet<string> = new Set([
  'text/calendar',
  'application/ics',
  'application/pkcs7-signature',
  'application/x-pkcs7-signature',
  'application/pgp-signature',
  'application/pgp-keys',
  'text/vcard',
  'text/x-vcard',
  'message/delivery-status',
  'message/disposition-notification',
  'text/rfc822-headers',
])

export function isMailMachineryPart(contentType: string | null | undefined): boolean {
  return MAIL_MACHINERY_TYPES.has(baseContentType(contentType))
}
