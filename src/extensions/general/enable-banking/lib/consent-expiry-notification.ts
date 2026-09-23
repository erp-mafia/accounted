import { type SupabaseClient } from '@supabase/supabase-js'
import { getEmailService } from '@/lib/email/service'
import {
  generateConsentExpiryEmailHtml,
  generateConsentExpiryEmailText,
  generateConsentExpiryEmailSubject,
} from '@/lib/email/consent-notification-templates'
import { getBranding } from '@/lib/branding/service'

/**
 * Send consent expiry notification email. Shared by the sync cron (consent
 * about to elapse) and the health probe cron (session found dead).
 * Guards with last_expiry_notification_at to avoid spamming (2-day cooldown).
 *
 * Paused by default (founder call 2026-07-29, after the probe backlog drain
 * mass-emailed 24 users at once): the settings panel and attention surfaces
 * already flag a dead connection in-app. Set BANK_CONSENT_EXPIRY_EMAILS=true
 * to resume sending; the status transitions below run either way.
 */
export async function sendConsentExpiryNotification(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
  connection: Record<string, unknown>,
  daysLeft: number,
  isExpired: boolean,
  baseUrl: string
): Promise<void> {
  try {
    if (process.env.BANK_CONSENT_EXPIRY_EMAILS !== 'true') return

    // Check cooldown: skip if notified within last 2 days
    const lastNotified = connection.last_expiry_notification_at as string | null
    if (lastNotified) {
      const hoursSinceNotified = (Date.now() - new Date(lastNotified).getTime()) / (1000 * 60 * 60)
      if (hoursSinceNotified < 48) return
    }

    const emailService = getEmailService()
    if (!emailService.isConfigured()) return

    const userId = connection.user_id as string

    // Look up user email
    const { data: userData } = await supabase.auth.admin.getUserById(userId)
    if (!userData?.user?.email) return

    // Look up company name
    const { data: companySettings } = await supabase
      .from('company_settings')
      .select('company_name')
      .eq('company_id', connection.company_id)
      .single()

    const emailData = {
      bankName: connection.bank_name as string,
      daysUntilExpiry: daysLeft,
      renewalUrl: `${baseUrl}/settings/banking`,
      companyName: companySettings?.company_name || '',
      isExpired,
    }

    await emailService.sendEmail({
      to: userData.user.email,
      subject: generateConsentExpiryEmailSubject(emailData),
      html: generateConsentExpiryEmailHtml(emailData),
      text: generateConsentExpiryEmailText(emailData),
      replyTo: getBranding().supportEmail,
    })

    // Update last notification timestamp
    await supabase
      .from('bank_connections')
      .update({ last_expiry_notification_at: new Date().toISOString() })
      .eq('id', connection.id as string)
  } catch (error) {
    // Notification failure must not break the cron job: log only.
    console.error('[bank-sync-cron] failed to send consent expiry notification:', error)
  }
}
