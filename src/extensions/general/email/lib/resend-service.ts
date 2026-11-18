/**
 * Resend Email Service Implementation
 *
 * Implements EmailService using the Resend API.
 */

import { getResendClient } from '@/lib/email/resend-client'
import { createLogger } from '@/lib/logger'
import { getBranding } from '@/lib/branding/service'
import type { EmailService, SendEmailOptions, SendEmailResult } from '@/lib/email/service'

const log = createLogger('email')

const DEFAULT_FROM_EMAIL = process.env.RESEND_FROM_EMAIL || 'noreply@localhost'

function sanitizeHeaderPart(s: string): string {
  return s.replace(/[\r\n<>]/g, '').trim()
}

// RFC 5322 "specials" that make a bare display name ambiguous (a comma splits
// the mailbox list, a quote or parenthesis opens a token). Names without any
// of them stay bare so existing headers are byte-identical.
const DISPLAY_NAME_SPECIALS = /[()<>[\]:;@\\,."]/

/** Quote a display name only when RFC 5322 requires it; escape `\` and `"`. */
export function encodeDisplayName(name: string): string {
  if (!DISPLAY_NAME_SPECIALS.test(name)) return name
  return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

// Conservative address shape for an explicit From: the local part comes from
// our own validated column and the domain is a verified hostname, so this is
// a last-line guard against a malformed row, not a full RFC 5322 parser.
const FROM_ADDRESS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9.-]{4,253}$/

/**
 * Builds the From header. With an explicit `from` (company's own verified
 * sending domain) the mail leaves as "<name> <address>" and the platform
 * sender is not involved at all. `fromAddress` is only ever set by
 * lib/email/brand-sender.ts for VERIFIED brand sender domains (WL-13).
 * Otherwise the platform default: "<fromName> <RESEND_FROM_EMAIL>" or
 * "<App> <RESEND_FROM_EMAIL>". A fromName WITHOUT an explicit address (a
 * brand or company riding the platform address) shows the name ALONE
 * (product call 2026-08-05: no "via <platform>" in the display name; the
 * platform stays visible in the actual From address until a sender domain
 * is verified).
 *
 * Strip CRLF and angle brackets from name parts to prevent header injection.
 * Resend's API does its own validation, but defense in depth: fromName and
 * from.name (user-controlled, from company settings) and appName
 * (admin-controlled, from branding) all flow into the From header.
 * Exported for unit tests.
 */
export function buildFromHeader(input: {
  fromName?: string
  from?: { name: string; address: string }
  fromAddress?: string
}): string {
  const safeAppName = sanitizeHeaderPart(getBranding().appName)

  if (input.from) {
    const address = input.from.address.trim().toLowerCase()
    const name = sanitizeHeaderPart(input.from.name)
    if (FROM_ADDRESS_PATTERN.test(address) && name) {
      return `${encodeDisplayName(name)} <${address}>`
    }
    // A malformed explicit sender falls through to the platform default
    // rather than failing the send: the fallback is the whole point.
  }

  const safeFromName = input.fromName ? sanitizeHeaderPart(input.fromName) : null
  const safeFromAddress = input.fromAddress ? sanitizeHeaderPart(input.fromAddress) : null
  if (safeFromAddress) {
    return safeFromName
      ? `${encodeDisplayName(safeFromName)} <${safeFromAddress}>`
      : safeFromAddress
  }
  return safeFromName
    ? `${encodeDisplayName(safeFromName)} <${DEFAULT_FROM_EMAIL}>`
    : `${encodeDisplayName(safeAppName)} <${DEFAULT_FROM_EMAIL}>`
}

function optionalAddressList(addresses: string | string[] | undefined): string[] | undefined {
  if (!addresses) return undefined
  const list = Array.isArray(addresses) ? addresses : [addresses]
  return list.length > 0 ? list : undefined
}

function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL && process.env.RESEND_FROM_EMAIL !== 'noreply@localhost'
}

/**
 * Whether Resend refused the request, so nothing went out: a 4xx answer.
 * Not 409, an idempotency conflict (the first request with this key may
 * still be sending, or was taken with another body), and not a missing
 * status: the SDK reports a request that got no answer at all ("Unable to
 * fetch data") with statusCode null, and Resend may have taken the mail. A
 * 5xx can come after Resend accepted it too. Exported for unit tests.
 */
export function isDefiniteRejection(error: { statusCode?: number | null }): boolean {
  const status = error.statusCode
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 409
}

/** The idempotency key of the retry as the platform sender: a different request, so a key of its own. */
export function platformSenderIdempotencyKey(key: string): string {
  return `${key}:platform-sender`
}

export class ResendEmailService implements EmailService {
  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const { to, cc, bcc, subject, html, text, replyTo, fromName, fromAddress, attachments, idempotencyKey } = options

    if (!this.isConfigured()) {
      return { success: false, error: 'Email service is not configured', outcomeUnknown: false }
    }

    const from = buildFromHeader({ fromName, from: options.from, fromAddress })
    const platformFrom = buildFromHeader({ fromName })

    let attempted = false
    try {
      const resend = getResendClient()
      const payload = {
        to: Array.isArray(to) ? to : [to],
        cc: optionalAddressList(cc),
        bcc: optionalAddressList(bcc),
        subject,
        html,
        text,
        replyTo,
        attachments: attachments?.map(att => ({
          filename: att.filename,
          content: typeof att.content === 'string'
            ? Buffer.from(att.content, 'base64')
            : Buffer.from(att.content),
          contentType: att.contentType,
        })),
      }
      const send = (sender: string, key: string | undefined) =>
        key ? resend.emails.send({ from: sender, ...payload }, { idempotencyKey: key }) : resend.emails.send({ from: sender, ...payload })
      attempted = true
      let response = await send(from, idempotencyKey)

      // A company's own sending domain can stop being accepted after the
      // fact (DKIM removed, Resend flipped the domain to failed before the
      // webhook or a manual re-check caught up). When Resend refused the
      // send, nothing went out: retry once as the platform sender rather
      // than letting every invoice for that company fail. The row is
      // corrected by the next verification check; this only keeps mail
      // flowing. Never on an answer that may hide a sent mail (no status, a
      // server error, an idempotency conflict): the retry could deliver it
      // twice. Nor on a rate or quota limit, which is not about the sender.
      if (response.error && from !== platformFrom && isDefiniteRejection(response.error) && response.error.statusCode !== 429) {
        log.warn('Resend rejected the company sender, retrying as the platform sender', {
          from,
          error: response.error.message,
          statusCode: response.error.statusCode,
        })
        response = await send(platformFrom, idempotencyKey ? platformSenderIdempotencyKey(idempotencyKey) : undefined)
      }

      if (response.error) {
        log.error('Resend error:', response.error)
        return {
          success: false,
          provider: 'resend',
          error: response.error.message,
          outcomeUnknown: !isDefiniteRejection(response.error),
        }
      }

      return { success: true, provider: 'resend', messageId: response.data?.id }
    } catch (error) {
      log.error('Failed to send email:', error)
      return {
        success: false,
        provider: 'resend',
        error: error instanceof Error ? error.message : 'Unknown error',
        // Thrown while a request was out: it may have been taken.
        outcomeUnknown: attempted,
      }
    }
  }

  isConfigured(): boolean {
    return isResendConfigured()
  }
}
