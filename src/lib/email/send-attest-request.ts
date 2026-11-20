import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany } from '@/lib/email/brand-sender'
import {
  ATTEST_REQUEST_TEMPLATE,
  generateAttestRequestEmailHtml,
  generateAttestRequestEmailSubject,
  generateAttestRequestEmailText,
  type AttestRequestEmailData,
} from '@/lib/email/attest-request-templates'
import type { Logger } from '@/lib/logger'

/**
 * Mail an attester the Godkänn / Neka links for a supplier invoice
 * (lib/supplier-invoices/attest-notify.ts). Brand mail (WL-13): the sender
 * follows the brand of the company. A send failure never throws: the
 * worklist row still asks for the attest.
 */
export async function sendAttestRequestMail(params: {
  companyId: string
  email: string
  data: Omit<AttestRequestEmailData, 'appName'>
  log: Logger
}): Promise<{ emailSent: boolean }> {
  const { companyId, email, log } = params
  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured: attest request mail skipped', { template: ATTEST_REQUEST_TEMPLATE })
    return { emailSent: false }
  }
  const sender = await getSenderForCompany(companyId)
  const data: AttestRequestEmailData = { ...params.data, appName: sender.brand?.appName }
  const result = await emailService.sendEmail({
    to: email,
    subject: generateAttestRequestEmailSubject(data),
    html: generateAttestRequestEmailHtml(data),
    text: generateAttestRequestEmailText(data),
    fromName: sender.fromName ?? undefined,
    fromAddress: sender.fromAddress ?? undefined,
    replyTo: sender.replyTo ?? undefined,
  })
  if (result.success) {
    // The address is the recipient's, the URLs carry the token: neither is logged.
    log.info('attest request mail sent', { template: ATTEST_REQUEST_TEMPLATE, messageId: result.messageId })
    return { emailSent: true }
  }
  log.error('attest request mail send failed', new Error(result.error ?? 'unknown'), { template: ATTEST_REQUEST_TEMPLATE })
  return { emailSent: false }
}
