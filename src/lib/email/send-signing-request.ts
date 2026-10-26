import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany } from '@/lib/email/brand-sender'
import {
  SIGNING_REQUEST_TEMPLATE,
  generateSigningRequestEmailHtml,
  generateSigningRequestEmailSubject,
  generateSigningRequestEmailText,
} from '@/lib/email/signing-request-templates'
import type { Logger } from '@/lib/logger'

/**
 * Mail a signer their link to a signing request (lib/signing/requests.ts).
 * Brand mail (WL-13): the sender identity follows the brand of the company.
 * A send failure never throws: the link stays valid and the sender can copy
 * it instead, with emailSent false.
 */
export async function sendSigningRequestMail(params: {
  companyId: string
  companyName: string
  requester: string
  title: string
  email: string
  url: string
  expiresAt: string
  message: string | null
  reminder?: boolean
  log: Logger
}): Promise<{ emailSent: boolean }> {
  const { companyId, email, url, log } = params
  const sender = await getSenderForCompany(companyId)
  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured: signing request mail skipped', { template: SIGNING_REQUEST_TEMPLATE })
    return { emailSent: false }
  }
  const data = {
    companyName: params.companyName,
    requester: params.requester,
    title: params.title,
    signingUrl: url,
    expiresAt: params.expiresAt,
    message: params.message,
    reminder: params.reminder ?? false,
    appName: sender.brand?.appName,
  }
  const result = await emailService.sendEmail({
    to: email,
    subject: generateSigningRequestEmailSubject(data),
    html: generateSigningRequestEmailHtml(data),
    text: generateSigningRequestEmailText(data),
    fromName: sender.fromName ?? undefined,
    fromAddress: sender.fromAddress ?? undefined,
    replyTo: sender.replyTo ?? undefined,
  })
  if (result.success) {
    // The address is the recipient's, the URL carries the token: neither is logged.
    log.info('signing request mail sent', { template: SIGNING_REQUEST_TEMPLATE, messageId: result.messageId })
    return { emailSent: true }
  }
  log.error('signing request mail send failed', new Error(result.error ?? 'unknown'), { template: SIGNING_REQUEST_TEMPLATE })
  return { emailSent: false }
}
