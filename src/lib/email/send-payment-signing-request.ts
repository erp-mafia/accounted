import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany } from '@/lib/email/brand-sender'
import {
  PAYMENT_SIGNING_REQUEST_TEMPLATE,
  generatePaymentSigningRequestEmailHtml,
  generatePaymentSigningRequestEmailSubject,
  generatePaymentSigningRequestEmailText,
} from '@/lib/email/payment-signing-request-templates'
import type { Logger } from '@/lib/logger'

/**
 * Mail a payment signing link (lib/payments/orders/signing-links.ts) to the
 * firmatecknare. Brand mail (WL-13): the sender identity follows the brand of
 * the company the payments leave from, as for the signatory link of a bank
 * consent. A send failure never throws: the link stays valid and the caller
 * shows it for copying, with emailSent false.
 */
export async function sendPaymentSigningRequestMail(params: {
  companyId: string
  companyName: string
  requester: string
  orderCount: number
  totalAmount: number
  currency: string
  email: string
  url: string
  expiresAt: string
  note: string | null
  log: Logger
}): Promise<{ emailSent: boolean }> {
  const { companyId, email, url, log } = params
  const sender = await getSenderForCompany(companyId)
  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured: payment signing link mail skipped', { template: PAYMENT_SIGNING_REQUEST_TEMPLATE })
    return { emailSent: false }
  }
  const data = {
    companyName: params.companyName,
    requester: params.requester,
    orderCount: params.orderCount,
    totalAmount: params.totalAmount,
    currency: params.currency,
    signingUrl: url,
    expiresAt: params.expiresAt,
    note: params.note,
    appName: sender.brand?.appName,
  }
  const result = await emailService.sendEmail({
    to: email,
    subject: generatePaymentSigningRequestEmailSubject(data),
    html: generatePaymentSigningRequestEmailHtml(data),
    text: generatePaymentSigningRequestEmailText(data),
    fromName: sender.fromName ?? undefined,
    fromAddress: sender.fromAddress ?? undefined,
    replyTo: sender.replyTo ?? undefined,
  })
  if (result.success) {
    // The address is the recipient's, the URL carries the token: neither is logged.
    log.info('payment signing link mail sent', { template: PAYMENT_SIGNING_REQUEST_TEMPLATE, messageId: result.messageId })
    return { emailSent: true }
  }
  log.error('payment signing link mail send failed', new Error(result.error ?? 'unknown'), { template: PAYMENT_SIGNING_REQUEST_TEMPLATE })
  return { emailSent: false }
}
