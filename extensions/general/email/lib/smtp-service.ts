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

    // Strip CRLF and angle brackets from name parts to prevent header
    // injection: fromName is user-controlled (company settings), appName is
    // admin-controlled (branding). Same defence as the Resend service.
    const safeAppName = sanitizeHeaderPart(getBranding().appName)
    const safeFromName = fromName ? sanitizeHeaderPart(fromName) : null
    const from = safeFromName
      ? `${safeFromName} via ${safeAppName} <${settings.fromEmail}>`
      : `${safeAppName} <${settings.fromEmail}>`

    try {
      const info = await getTransport(settings).sendMail({
        from,
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
      })
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
