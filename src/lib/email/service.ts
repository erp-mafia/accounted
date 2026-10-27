/**
 * Email Service Interface
 *
 * Core defines the contract. The email extension registers a real
 * implementation (Resend). Without the extension, a no-op service
 * is used: email-dependent features degrade gracefully.
 */
import { whenInitialized } from '@/lib/initialized'
import { globalSingleton } from '@/lib/global-singleton'

export interface SendEmailOptions {
  to: string | string[]
  cc?: string | string[]
  bcc?: string | string[]
  subject: string
  html: string
  text?: string
  replyTo?: string
  fromName?: string
  /**
   * Explicit From address. Only ever set by lib/email/brand-sender.ts for
   * brands whose Resend sender domain is VERIFIED. When absent, the provider
   * sends from its default address (RESEND_FROM_EMAIL) with fromName as the
   * display name.
   */
  fromAddress?: string
  /**
   * Explicit From identity (company's own verified sending domain). When
   * set, the provider sends as "<name> <address>" instead of the platform
   * sender; `fromName` is ignored. Callers obtain it from
   * resolveInvoiceSender(): never build one from raw user input.
   */
  from?: { name: string; address: string }
  attachments?: Array<{
    filename: string
    content: Buffer | string
    contentType?: string
  }>
  /**
   * The same key on a second request makes the provider answer the first
   * one's result instead of sending again (Resend keeps it 24 hours). A
   * provider without the concept (SMTP) ignores it.
   */
  idempotencyKey?: string
}

export interface SendEmailResult {
  success: boolean
  provider?: string
  messageId?: string
  error?: string
  /**
   * On a failure: true when the mail may have gone out anyway (no answer, a
   * server error after the provider took it, an idempotency conflict);
   * false when the provider refused it, so nothing went out. Absent: the
   * service cannot tell, and a caller that must not send twice reads it as
   * unknown.
   */
  outcomeUnknown?: boolean
}

export interface EmailService {
  sendEmail(options: SendEmailOptions): Promise<SendEmailResult>
  isConfigured(): boolean
}

class NoopEmailService implements EmailService {
  async sendEmail(): Promise<SendEmailResult> {
    return { success: false, error: 'Email service not configured' }
  }
  isConfigured(): boolean {
    return false
  }
}

// Process-wide (lib/global-singleton.ts): the email extension registers
// through the copy of this module lib/init loads, a route reads through its own.
const holder = globalSingleton('emailService', (): { service: EmailService } => ({
  service: new NoopEmailService(),
}))

/** The registered service, after the extensions have loaded (lib/initialized.ts). */
export async function getEmailService(): Promise<EmailService> {
  await whenInitialized()
  return holder.service
}

export function registerEmailService(svc: EmailService): void {
  holder.service = svc
}
