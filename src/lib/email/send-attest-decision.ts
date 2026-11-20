import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany } from '@/lib/email/brand-sender'
import {
  ATTEST_DECISION_TEMPLATE,
  generateAttestDecisionEmailHtml,
  generateAttestDecisionEmailSubject,
  generateAttestDecisionEmailText,
  type AttestDecisionEmailData,
} from '@/lib/email/attest-decision-templates'
import type { Logger } from '@/lib/logger'

/**
 * Mail whoever registered supplier invoices what the attester decided on
 * them (lib/supplier-invoices/attest-decision-notify.ts). Brand mail (WL-13):
 * the sender follows the brand of the company. A send failure never throws:
 * the Att göra row and the byrå client list still show the invoices.
 */
export async function sendAttestDecisionMail(params: {
  companyId: string
  email: string
  data: Omit<AttestDecisionEmailData, 'appName'>
  log: Logger
}): Promise<{ emailSent: boolean }> {
  const { companyId, email, log } = params
  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured: attest decision mail skipped', { template: ATTEST_DECISION_TEMPLATE })
    return { emailSent: false }
  }
  const sender = await getSenderForCompany(companyId)
  const data: AttestDecisionEmailData = { ...params.data, appName: sender.brand?.appName }
  const result = await emailService.sendEmail({
    to: email,
    subject: generateAttestDecisionEmailSubject(data),
    html: generateAttestDecisionEmailHtml(data),
    text: generateAttestDecisionEmailText(data),
    fromName: sender.fromName ?? undefined,
    fromAddress: sender.fromAddress ?? undefined,
    replyTo: sender.replyTo ?? undefined,
  })
  if (result.success) {
    log.info('attest decision mail sent', { template: ATTEST_DECISION_TEMPLATE, messageId: result.messageId })
    return { emailSent: true }
  }
  log.error('attest decision mail send failed', new Error(result.error ?? 'unknown'), { template: ATTEST_DECISION_TEMPLATE })
  return { emailSent: false }
}
