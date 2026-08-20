import type { EmailService } from '@/lib/email/service'
import { ResendEmailService } from './resend-service'
import { SmtpEmailService } from './smtp-service'

export type EmailProviderKind = 'resend' | 'smtp'

/**
 * Which outbound-mail implementation this deployment uses.
 *
 *   1. EMAIL_PROVIDER=resend|smtp wins when set (the escape hatch for a
 *      deployment that has both configured).
 *   2. RESEND_API_KEY present: Resend. This keeps hosted byte-identical:
 *      adding SMTP variables on the side can never move hosted mail.
 *   3. SMTP_HOST present: SMTP. The sovereign self-host path.
 *   4. Otherwise Resend, whose isConfigured() is false, so email-dependent
 *      features degrade exactly as before (PDF download, no send).
 */
export function resolveEmailProvider(): EmailProviderKind {
  const explicit = (process.env.EMAIL_PROVIDER ?? '').trim().toLowerCase()
  if (explicit === 'resend' || explicit === 'smtp') return explicit
  if (process.env.RESEND_API_KEY) return 'resend'
  if (process.env.SMTP_HOST) return 'smtp'
  return 'resend'
}

export function createEmailService(provider: EmailProviderKind = resolveEmailProvider()): EmailService {
  return provider === 'smtp' ? new SmtpEmailService() : new ResendEmailService()
}
