/**
 * SMTP Email Service Implementation
 *
 * Implements EmailService over any SMTP relay via nodemailer: the provider a
 * sovereign self-host uses instead of Resend (US), e.g. a Swedish mail
 * provider, a byrå's own Microsoft 365 / Google Workspace relay, or Postfix
 * on the host. Selected by EMAIL_PROVIDER=smtp (or auto-detected from
 * SMTP_HOST when no RESEND_API_KEY is set): see email-provider.ts.
 *
 * Environment:
 *   SMTP_HOST                      required
 *   SMTP_PORT                      default 587
 *   SMTP_SECURE                    "true" = implicit TLS (port 465); default
 *                                  false = plain + STARTTLS upgrade
 *   SMTP_USER / SMTP_PASS          optional (an internal relay may be open to
 *                                  the Docker network only)
 *   SMTP_FROM_EMAIL                required: the envelope/From address
 *   SMTP_TLS_REJECT_UNAUTHORIZED   default true; "false" accepts a relay's
 *                                  self-signed certificate (LAN relays only)
 *
 * The From header is built exactly like the Resend service does it, with the
 * same header-injection defence, so a customer sees the same sender shape
 * whichever provider the operator picked.
 */

import nodemailer, { type Transporter } from 'nodemailer'
import { createLogger } from '@/lib/logger'
import { getBranding } from '@/lib/branding/service'
import type { EmailService, SendEmailOptions, SendEmailResult } from '@/lib/email/service'

const log = createLogger('email-smtp')

function sanitizeHeaderPart(s: string): string {
  return s.replace(/[\r\n<>]/g, '').trim()
}

// RFC 5322 "specials" that make a bare display name ambiguous (a comma splits
// the mailbox list, a quote or parenthesis opens a token). Mirrors
// resend-service.ts so both providers emit the same From shape.
const DISPLAY_NAME_SPECIALS = /[()<>[\]:;@\\,."]/

/** Quote a display name only when RFC 5322 requires it; escape `\` and `"`. */
function encodeDisplayName(name: string): string {
  if (!DISPLAY_NAME_SPECIALS.test(name)) return name
  return `"${name.replace(/[\\"]/g, (c) => `\\${c}`)}"`
}

// Same conservative shape as resend-service.ts: a last-line guard against a
// malformed company_sending_domains row, not an RFC 5322 parser.
const FROM_ADDRESS_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}@[a-z0-9.-]{4,253}$/

/**
 * Builds the From header exactly like resend-service.ts buildFromHeader().
 * With an explicit `from` (the company's own verified sending domain, #1802)
 * the mail leaves as "<name> <address>" and the relay's default sender is not
 * involved; otherwise "<fromName> via <App> <SMTP_FROM_EMAIL>" or
 * "<App> <SMTP_FROM_EMAIL>". A malformed explicit sender falls through to the
 * platform default rather than failing the send.
 *
 * Mirrored rather than imported because the platform fallback address differs
 * per provider (RESEND_FROM_EMAIL there, SMTP_FROM_EMAIL here). Same
 * header-injection defence: CRLF and angle brackets are stripped from every
 * name part. Exported for unit tests.
 */
export function buildSmtpFromHeader(input: {
  fromName?: string
  from?: { name: string; address: string }
  defaultFromEmail: string
}): string {
  const safeAppName = sanitizeHeaderPart(getBranding().appName)

  if (input.from) {
    const address = input.from.address.trim().toLowerCase()
    const name = sanitizeHeaderPart(input.from.name)
    if (FROM_ADDRESS_PATTERN.test(address) && name) {
      return `${encodeDisplayName(name)} <${address}>`
    }
  }

  const safeFromName = input.fromName ? sanitizeHeaderPart(input.fromName) : null
  return safeFromName
    ? `${encodeDisplayName(`${safeFromName} via ${safeAppName}`)} <${input.defaultFromEmail}>`
    : `${encodeDisplayName(safeAppName)} <${input.defaultFromEmail}>`
}

function optionalAddressList(addresses: string | string[] | undefined): string[] | undefined {
  if (!addresses) return undefined
  const list = Array.isArray(addresses) ? addresses : [addresses]
  return list.length > 0 ? list : undefined
}

function envBool(name: string, fallback: boolean): boolean {
  const v = process.env[name]?.trim().toLowerCase()
  if (v === undefined || v === '') return fallback
  if (v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return fallback
}

export interface SmtpSettings {
  host: string
  port: number
  secure: boolean
  user: string | null
  pass: string | null
  fromEmail: string
  rejectUnauthorized: boolean
}

/** Read the SMTP settings from the environment; null when the minimum (host + from) is missing. */
export function readSmtpSettings(): SmtpSettings | null {
  const host = process.env.SMTP_HOST?.trim()
  const fromEmail = process.env.SMTP_FROM_EMAIL?.trim()
  if (!host || !fromEmail) return null
  const parsedPort = Number(process.env.SMTP_PORT)
  const secure = envBool('SMTP_SECURE', false)
  return {
    host,
    port: Number.isFinite(parsedPort) && parsedPort > 0 ? Math.floor(parsedPort) : secure ? 465 : 587,
    secure,
    user: process.env.SMTP_USER?.trim() || null,
    pass: process.env.SMTP_PASS ?? null,
    fromEmail,
    rejectUnauthorized: envBool('SMTP_TLS_REJECT_UNAUTHORIZED', true),
  }
}

export function isSmtpConfigured(): boolean {
  return readSmtpSettings() !== null
}

let cachedTransport: { key: string; transport: Transporter } | null = null

function getTransport(settings: SmtpSettings): Transporter {
  const key = JSON.stringify({ ...settings, pass: settings.pass ? 'set' : 'unset' })
  if (cachedTransport && cachedTransport.key === key) return cachedTransport.transport
  const transport = nodemailer.createTransport({
    host: settings.host,
    port: settings.port,
    secure: settings.secure,
    ...(settings.user ? { auth: { user: settings.user, pass: settings.pass ?? '' } } : {}),
    tls: { rejectUnauthorized: settings.rejectUnauthorized },
  })
  cachedTransport = { key, transport }
  return transport
}

/** Tests only: forget the cached transport so the next send re-reads the environment. */
export function resetSmtpTransportForTests(): void {
  cachedTransport = null
}

export class SmtpEmailService implements EmailService {
  async sendEmail(options: SendEmailOptions): Promise<SendEmailResult> {
    const { to, cc, bcc, subject, html, text, replyTo, fromName, attachments } = options

    const settings = readSmtpSettings()
    if (!settings) {
      return { success: false, error: 'Email service is not configured' }
    }

    const from = buildSmtpFromHeader({ fromName, from: options.from, defaultFromEmail: settings.fromEmail })
    const platformFrom = buildSmtpFromHeader({ fromName, defaultFromEmail: settings.fromEmail })
    const mail = {
      to: Array.isArray(to) ? to : [to],
      cc: optionalAddressList(cc),
      bcc: optionalAddressList(bcc),
      subject,
      html,
      text,
      replyTo,
      attachments: attachments?.map((att) => ({
        filename: att.filename,
        content:
          typeof att.content === 'string' ? Buffer.from(att.content, 'base64') : Buffer.from(att.content),
        contentType: att.contentType,
      })),
    }

    try {
      const transport = getTransport(settings)
      let info: { messageId?: string }
      try {
        info = await transport.sendMail({ from, ...mail })
      } catch (error) {
        // Same fallback as the Resend service: a relay may refuse to send as
        // an address it does not own (e.g. a Microsoft 365 "send as" policy).
        // The relay rejected the message, so nothing went out: retry once as
        // the platform sender rather than failing every invoice for that
        // company.
        if (from === platformFrom) throw error
        log.warn('SMTP relay rejected the company sender, retrying as the platform sender', {
          from,
          error: error instanceof Error ? error.message : String(error),
        })
        info = await transport.sendMail({ from: platformFrom, ...mail })
      }
      return { success: true, provider: 'smtp', messageId: info.messageId }
    } catch (error) {
      log.error('Failed to send email over SMTP:', error)
      return {
        success: false,
        provider: 'smtp',
        error: error instanceof Error ? error.message : 'Unknown error',
      }
    }
  }

  isConfigured(): boolean {
    return isSmtpConfigured()
  }
}
