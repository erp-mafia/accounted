import { getEmailService } from '@/lib/email/service'
import { getSenderForCompany, getBaseUrlForBrand } from '@/lib/email/brand-sender'
import {
  generateInviteEmailSubject,
  generateInviteEmailHtml,
  generateInviteEmailText,
} from '@/lib/email/invite-templates'
import type { Logger } from '@/lib/logger'

export interface CompanyInviteMailResult {
  /** The accept link, always produced so the inviter can share it directly. */
  inviteUrl: string
  /** False when the service is unconfigured or the provider send failed. */
  emailSent: boolean
}

/**
 * Send a company invitation mail. Brand mail (WL-13): the sender identity and
 * the accept link follow the brand of the company the invite concerns; a
 * company without a brand uses the validated request origin (`appOrigin`,
 * from resolveRequestAppOrigin) and the platform sender.
 *
 * Shared by invite creation (POST /api/company/members/invite) and re-send
 * (POST /api/company/members/invite/[id]) so the two paths cannot drift; the
 * byrå-team counterpart is sendTeamInviteMail. A send failure never throws:
 * the invitation stays valid and the caller surfaces emailSent: false
 * together with the link.
 */
export async function sendCompanyInviteMail(params: {
  companyId: string
  companyName: string | null | undefined
  email: string
  inviterEmail: string
  token: string
  appOrigin: string
  log: Logger
}): Promise<CompanyInviteMailResult> {
  const { companyId, companyName, email, inviterEmail, token, appOrigin, log } = params

  const sender = await getSenderForCompany(companyId)
  const appUrl = sender.brand ? getBaseUrlForBrand(sender.brand) : appOrigin
  const inviteUrl = `${appUrl}/invite/${token}`

  let emailSent = false
  const emailService = getEmailService()
  if (emailService.isConfigured()) {
    const emailData = {
      companyName: companyName || 'Företag',
      inviterEmail,
      inviteUrl,
      appName: sender.brand?.appName,
    }

    const result = await emailService.sendEmail({
      to: email,
      subject: generateInviteEmailSubject(emailData),
      html: generateInviteEmailHtml(emailData),
      text: generateInviteEmailText(emailData),
      fromName: sender.fromName ?? undefined,
      fromAddress: sender.fromAddress ?? undefined,
      replyTo: sender.replyTo ?? undefined,
    })

    if (result.success) {
      emailSent = true
      log.info('invite email sent', { to: email, messageId: result.messageId })
    } else {
      log.error('invite email send failed', new Error(result.error ?? 'unknown'), { to: email })
    }
  } else {
    log.warn('email service not configured: invite email skipped', { to: email })
  }

  return { inviteUrl, emailSent }
}
