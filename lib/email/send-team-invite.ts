import { getEmailService } from '@/lib/email/service'
import { getSenderForBrand, getBaseUrlForBrand } from '@/lib/email/brand-sender'
import { resolveBrandForTeam } from '@/lib/branding/resolve'
import {
  generateTeamInviteEmailSubject,
  generateTeamInviteEmailHtml,
  generateTeamInviteEmailText,
} from '@/lib/email/invite-templates'
import { createLogger } from '@/lib/logger'

const log = createLogger('team-invite-mail')

export interface TeamInviteMailResult {
  /** The accept link, always produced so the inviter can share it directly. */
  inviteUrl: string
  /** False when the service is unconfigured or the provider send failed. */
  emailSent: boolean
}

/**
 * Send a byrå-team invitation mail in the team's brand (WL-13): sender
 * identity via getSenderForBrand(resolveBrandForTeam(teamId)) and the accept
 * link on the brand's home domain, canonical for brandless teams.
 *
 * Shared by invite creation and re-send so the two paths cannot drift. A send
 * failure never throws: the invitation stays valid and the caller surfaces
 * emailSent: false together with the link.
 */
export async function sendTeamInviteMail(params: {
  teamId: string
  email: string
  inviterEmail: string
  token: string
}): Promise<TeamInviteMailResult> {
  const { teamId, email, inviterEmail, token } = params

  const brand = await resolveBrandForTeam(teamId)
  const sender = getSenderForBrand(brand)
  const appUrl = getBaseUrlForBrand(brand)
  const inviteUrl = `${appUrl}/invite/${token}`

  let emailSent = false
  const emailService = getEmailService()
  if (emailService.isConfigured()) {
    const emailData = {
      inviterEmail,
      inviteUrl,
      appName: sender.brand?.appName,
    }
    const result = await emailService.sendEmail({
      to: email,
      subject: generateTeamInviteEmailSubject(emailData),
      html: generateTeamInviteEmailHtml(emailData),
      text: generateTeamInviteEmailText(emailData),
      fromName: sender.fromName ?? undefined,
      fromAddress: sender.fromAddress ?? undefined,
      replyTo: sender.replyTo ?? undefined,
    })
    if (result.success) {
      emailSent = true
      log.info('team invite email sent', { to: email, teamId, messageId: result.messageId })
    } else {
      log.error('team invite email send failed', new Error(result.error ?? 'unknown'), {
        to: email,
        teamId,
      })
    }
  } else {
    log.warn('email service not configured: team invite email skipped', { to: email, teamId })
  }

  return { inviteUrl, emailSent }
}
