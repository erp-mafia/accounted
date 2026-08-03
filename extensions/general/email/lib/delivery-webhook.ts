/**
 * Resend outbound delivery webhook.
 *
 * "Accepted by Resend" and "the recipient's server took it" are two different
 * facts, and only the first one is known when a send returns. Resend reports
 * the second one asynchronously. Resend identifies the recipient(s) affected
 * by each event in `data.to`, which lets one message carry independent To/CC
 * outcomes. This module verifies the signed payload and maps it onto the
 * provider status stored on the invoice delivery row.
 */

import { Resend } from 'resend'
import type { WebhookEventPayload } from 'resend'
import type { InvoiceDeliveryProviderStatus } from '@/types'

export class ResendDeliverySignatureError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ResendDeliverySignatureError'
  }
}

export interface ProviderDeliveryReport {
  providerMessageId: string
  status: InvoiceDeliveryProviderStatus
  occurredAt: string
  detail: string | null
  recipients: string[]
}

/**
 * Events that say something about whether the message arrived. `email.sent`
 * and `email.scheduled` only repeat what the send call already told us, and
 * open/click tracking is not enabled: both are ignored on purpose.
 */
const STATUS_BY_EVENT: Record<string, InvoiceDeliveryProviderStatus> = {
  'email.delivered': 'delivered',
  'email.delivery_delayed': 'delayed',
  'email.complained': 'complained',
  'email.bounced': 'bounced',
  'email.failed': 'failed',
  'email.suppressed': 'suppressed',
}

export function isDeliveryWebhookConfigured(): boolean {
  return !!process.env.RESEND_DELIVERY_WEBHOOK_SECRET
}

/**
 * Verifies the Svix-signed payload against RESEND_DELIVERY_WEBHOOK_SECRET.
 * This is a separate Resend endpoint from the inbound document mailbox, so it
 * carries its own signing secret.
 */
export function verifyDeliveryWebhook(
  rawBody: string,
  requestHeaders: Headers,
): WebhookEventPayload {
  const secret = process.env.RESEND_DELIVERY_WEBHOOK_SECRET
  if (!secret) throw new Error('RESEND_DELIVERY_WEBHOOK_SECRET is required')

  const apiKey = process.env.RESEND_API_KEY
  if (!apiKey) throw new Error('RESEND_API_KEY is required')

  const svixHeaders = {
    id: requestHeaders.get('svix-id') ?? '',
    timestamp: requestHeaders.get('svix-timestamp') ?? '',
    signature: requestHeaders.get('svix-signature') ?? '',
  }

  try {
    return new Resend(apiKey).webhooks.verify({
      payload: rawBody,
      headers: svixHeaders,
      webhookSecret: secret,
    })
  } catch (err) {
    throw new ResendDeliverySignatureError(
      err instanceof Error ? err.message : 'Invalid signature',
    )
  }
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function recipientAddresses(value: unknown): string[] {
  if (!Array.isArray(value)) return []

  const seen = new Set<string>()
  const recipients: string[] = []

  for (const valueItem of value) {
    const address = text(valueItem)
    if (!address || address.length > 320) continue

    const normalized = address.toLocaleLowerCase('en-US')
    if (seen.has(normalized)) continue

    seen.add(normalized)
    recipients.push(address)
    if (recipients.length === 100) break
  }

  return recipients
}

/**
 * The reason is read defensively: the payload is external input, and a
 * provider that ships a new event shape must degrade to "no reason given"
 * rather than throw, which would turn every retry into another failed
 * delivery report.
 */
function reasonText(event: WebhookEventPayload): string | null {
  const data = event.data as {
    bounce?: { message?: unknown; subType?: unknown; type?: unknown }
    failed?: { reason?: unknown }
    suppressed?: { message?: unknown; type?: unknown }
  }

  if (event.type === 'email.bounced') {
    const classification = [text(data.bounce?.type), text(data.bounce?.subType)]
      .filter(Boolean)
      .join('/')
    return [text(data.bounce?.message), classification || null].filter(Boolean).join(' ') || null
  }
  if (event.type === 'email.failed') {
    return text(data.failed?.reason)
  }
  if (event.type === 'email.suppressed') {
    return [text(data.suppressed?.message), text(data.suppressed?.type)]
      .filter(Boolean)
      .join(' ') || null
  }
  return null
}

/**
 * Maps a verified event onto a delivery report, or null when the event says
 * nothing about arrival. The provider clock wins over ingestion time: webhooks
 * can be retried hours later, and the status timestamp must stay the moment
 * the outcome actually happened.
 */
export function toDeliveryReport(event: WebhookEventPayload): ProviderDeliveryReport | null {
  const status = STATUS_BY_EVENT[event.type]
  if (!status) return null

  const data = event.data as { email_id?: unknown; to?: unknown }
  const providerMessageId = text(data.email_id)
  if (!providerMessageId) return null

  const occurredAt = parseTimestamp(event.created_at)

  return {
    providerMessageId,
    status,
    occurredAt,
    detail: reasonText(event),
    recipients: recipientAddresses(data.to),
  }
}

function parseTimestamp(value: unknown): string {
  if (typeof value === 'string') {
    const parsed = new Date(value)
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString()
  }
  return new Date().toISOString()
}
