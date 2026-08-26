/**
 * Email Service Interface
 *
 * Core defines the contract. The email extension registers a real
 * implementation (Resend). Without the extension, a no-op service
 * is used: email-dependent features degrade gracefully.
 */

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
}

export interface SendEmailResult {
  success: boolean
  provider?: string
  messageId?: string
  error?: string
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

let emailService: EmailService = new NoopEmailService()

export function getEmailService(): EmailService {
  return emailService
}

export function registerEmailService(svc: EmailService): void {
  emailService = svc
}
