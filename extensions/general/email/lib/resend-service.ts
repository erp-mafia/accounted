/**
 * Resend Email Service Implementation
 *
 * Implements EmailService using the Resend API.
 */

import { Resend } from 'resend'
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
 * sender is not involved at all. Otherwise the platform default:
 * "<fromName> via <App> <RESEND_FROM_EMAIL>" or "<App> <RESEND_FROM_EMAIL>".
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
  return safeFromName
    ? `${encodeDisplayName(`${safeFromName} via ${safeAppName}`)} <${DEFAULT_FROM_EMAIL}>`
    : `${encodeDisplayName(safeAppName)} <${DEFAULT_FROM_EMAIL}>`
}

function optionalAddressList(addresses: string | string[] | undefined): string[] | undefined {
  if (!addresses) return undefined
  const list = Array.isArray(addresses) ? addresses : [addresses]
  return list.length > 0 ? list : undefined
}

let resendClient: Resend | null = null

function getResendClient(): Resend {
  if (!resendClient) {
    if (!process.env.RESEND_API_KEY) {
      throw new Error('RESEND_API_KEY is not configured')
    }
    resendClient = new Resend(process.env.RESEND_API_KEY)
  }
  return resendClient
}

function isResendConfigured(): boolean {
  return !!process.env.RESEND_API_KEY && !!process.env.RESEND_FROM_EMAIL && process.env.RESEND_FROM_EMAIL !== 'noreply@localhost'
}

export class ResendEmailService implements EmailService {
  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const { to, cc, bcc, subject, html, text, replyTo, fromName, attachments } = options

    if (!this.isConfigured()) {
      return { success: false, error: 'Email service is not configured' }
    }

    const from = buildFromHeader({ fromName, from: options.from })
    const platformFrom = buildFromHeader({ fromName })

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
      let response = await resend.emails.send({ from, ...payload })

      // A company's own sending domain can stop being accepted after the
      // fact (DKIM removed, Resend flipped the domain to failed before the
      // webhook or a manual re-check caught up). Resend rejected the send,
      // so nothing went out: retry once as the platform sender rather than
      // letting every invoice for that company fail. The row is corrected by
      // the next verification check; this only keeps mail flowing.
      if (response.error && from !== platformFrom) {
        log.warn('Resend rejected the company sender, retrying as the platform sender', {
          from,
          error: response.error.message,
        })
        response = await resend.emails.send({ from: platformFrom, ...payload })
      }

      if (response.error) {
        log.error('Resend error:', response.error)
        return { success: false, provider: 'resend', error: response.error.message }
      }

      return { success: true, provider: 'resend', messageId: response.data?.id }
    } catch (error) {
      log.error('Failed to send email:', error)
      return {
        success: false,
        provider: 'resend',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  isConfigured(): boolean {
    return isResendConfigured()
  }
}
