import { Resend } from 'resend'
import type { EmailReceivedEvent, GetReceivingEmailResponseSuccess, WebhookEventPayload } from 'resend'

export type ResendInboundEvent = EmailReceivedEvent

export type ResendReceivedEmail = GetReceivingEmailResponseSuccess

export interface ResendAttachmentDownload {
  id: string
  filename: string
  contentType: string
  buffer: ArrayBuffer
}

function getResend(): Resend {
  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is required')
  return new Resend(apiKey)
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

  const resend = getResend()
  try {
    return resend.webhooks.verify({ payload: rawBody, headers: svixHeaders, webhookSecret: secret })
  } catch (err) {
    throw new ResendSignatureError(err instanceof Error ? err.message : 'Invalid signature')
  }
}

// Fetches the full received email (body, headers, attachment metadata) by email_id.
export async function fetchReceivingEmail(emailId: string): Promise<ResendReceivedEmail> {
  const resend = getResend()
  const { data, error } = await resend.emails.receiving.get(emailId)
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
  const resend = getResend()
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

// Parses the first recipient whose domain matches our configured inbound domain,
// returning just the local_part. Returns null if no match.
export function extractLocalPartForDomain(recipients: string[], domain: string): string | null {
  const normalized = domain.toLowerCase()
  for (const addr of recipients) {
    const match = addr.match(/^\s*([^@\s]+)@([^@\s]+?)\s*$/)
    if (!match) continue
    const [, localPart, addrDomain] = match
    if (addrDomain.toLowerCase() === normalized) return localPart.toLowerCase()
  }
  return null
}

// Splits every parseable recipient into { localPart, domain }, lowercased and
// in original order. Used to match recipients against per-company verified
// custom domains when none of them is on the shared inbound domain.
export function parseRecipients(recipients: string[]): Array<{ localPart: string; domain: string }> {
  const parsed: Array<{ localPart: string; domain: string }> = []
  for (const addr of recipients) {
    const match = addr.match(/^\s*([^@\s]+)@([^@\s]+?)\s*$/)
    if (!match) continue
    parsed.push({ localPart: match[1].toLowerCase(), domain: match[2].toLowerCase() })
  }
  return parsed
}

export function isEmailReceivedEvent(event: WebhookEventPayload): event is EmailReceivedEvent {
  return event.type === 'email.received'
}
