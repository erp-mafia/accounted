import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany } from '@/lib/email/brand-sender'
import {
  BANK_CONNECT_INVITE_TEMPLATE,
  generateBankConnectInviteEmailHtml,
  generateBankConnectInviteEmailSubject,
  generateBankConnectInviteEmailText,
} from '@/lib/email/bank-connect-invite-templates'
import type { Logger } from '@/lib/logger'

/**
 * Mail a signatory link (lib/bank-feed/invites.ts) to the firmatecknare.
 * Brand mail (WL-13): the sender identity follows the brand of the company
 * the link concerns, as for the company invite. A send failure never throws:
 * the link stays valid and the caller shows it for copying, with
 * emailSent: false.
 */
export async function sendBankConnectInviteMail(params: {
  companyId: string
  companyName: string
  requester: string
  bankName: string | null
  email: string
  url: string
  offerPayments: boolean
  log: Logger
}): Promise<{ emailSent: boolean }> {
  const { companyId, companyName, requester, bankName, email, url, offerPayments, log } = params
  const sender = await getSenderForCompany(companyId)
  const emailService = await getEmailService()
  if (!emailService.isConfigured()) {
    log.warn('email service not configured: signatory link mail skipped', { template: BANK_CONNECT_INVITE_TEMPLATE })
    return { emailSent: false }
  }
  const data = { companyName, requester, bankName, inviteUrl: url, offerPayments, appName: sender.brand?.appName }
  const result = await emailService.sendEmail({
    to: email,
    subject: generateBankConnectInviteEmailSubject(data),
    html: generateBankConnectInviteEmailHtml(data),
    text: generateBankConnectInviteEmailText(data),
    fromName: sender.fromName ?? undefined,
    fromAddress: sender.fromAddress ?? undefined,
    replyTo: sender.replyTo ?? undefined,
  })
  if (result.success) {
    // The address is the recipient's, the URL carries the token: neither is logged.
    log.info('signatory link mail sent', { template: BANK_CONNECT_INVITE_TEMPLATE, messageId: result.messageId })
    return { emailSent: true }
  }
  log.error('signatory link mail send failed', new Error(result.error ?? 'unknown'), { template: BANK_CONNECT_INVITE_TEMPLATE })
  return { emailSent: false }
}
