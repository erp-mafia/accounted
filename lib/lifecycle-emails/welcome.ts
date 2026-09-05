import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { getEmailService } from '@/lib/email/service'
import { getBranding } from '@/lib/branding/service'
import {
  generateWelcomeEmailHtml,
  generateWelcomeEmailSubject,
  generateWelcomeEmailText,
  type WelcomeEmailLang,
} from '@/lib/email/welcome-templates'

/**
 * Welcome email sweep.
 *
 * Runs from /api/lifecycle-emails/welcome/cron every couple of minutes and
 * mails every account whose address was confirmed inside the lookback window
 * and that has not been welcomed yet. Signup path does not matter: email +
 * password, Google and BankID all end with email_confirmed_at set, and the
 * candidate query (list_users_awaiting_lifecycle_email, service-role only)
 * is the one place the eligibility rules live.
 *
 * Delivery is claim-then-send: the user_lifecycle_emails row is inserted
 * FIRST and only a winning insert sends. A 23505 means another tick already
 * owns the user. A failed provider call releases the claim so the next tick
 * retries; the rare cost is a duplicate welcome when the provider accepted
 * the mail but reported an error, which beats a silent never-sent.
 */

export const WELCOME_EMAIL_KEY = 'welcome'

/**
 * How long after confirmation an account still earns the welcome mail. Long
 * enough to ride out a multi-day provider outage, short enough that the
 * first deploy of this cron does not re-welcome the whole user base.
 */
export const WELCOME_LOOKBACK_MS = 3 * 24 * 60 * 60 * 1000

export const WELCOME_BATCH_LIMIT = 50

export interface WelcomeCandidate {
  user_id: string
  email: string
  full_name: string | null
  locale: string | null
  confirmed_at: string
}

export interface WelcomeSweepSummary {
  /** false when no email provider is registered (self-hosted without the email extension): nothing is claimed. */
  configured: boolean
  candidates: number
  sent: number
  /** Claim lost to a concurrent tick. */
  skipped: number
  failed: number
}

/**
 * First name for the greeting. Returns null for anything that does not look
 * like a name so the template falls back to the bare "Hej,": an address
 * (some providers put the email in the name field), an empty string, or a
 * token so long it is clearly not a first name.
 */
export function firstNameFromFullName(fullName: string | null | undefined): string | null {
  if (!fullName) return null
  const first = fullName.trim().split(/\s+/)[0] ?? ''
  if (!first || first.includes('@') || first.length > 40) return null
  return first
}

function toLang(locale: string | null | undefined): WelcomeEmailLang {
  return locale === 'en' ? 'en' : 'sv'
}

export async function runWelcomeEmailSweep(
  supabase: SupabaseClient,
  options: { log: Logger; now?: number },
): Promise<WelcomeSweepSummary> {
  const { log } = options
  const now = options.now ?? Date.now()
  const emailService = getEmailService()

  const summary: WelcomeSweepSummary = {
    configured: emailService.isConfigured(),
    candidates: 0,
    sent: 0,
    skipped: 0,
    failed: 0,
  }

  if (!summary.configured) {
    log.info('welcome email sweep skipped: email service not configured')
    return summary
  }

  const since = new Date(now - WELCOME_LOOKBACK_MS).toISOString()
  const { data, error } = await supabase.rpc('list_users_awaiting_lifecycle_email', {
    p_email_key: WELCOME_EMAIL_KEY,
    p_confirmed_since: since,
    p_limit: WELCOME_BATCH_LIMIT,
  })
  if (error) {
    throw new Error(`welcome candidates lookup failed: ${error.message}`)
  }

  const candidates = (data ?? []) as WelcomeCandidate[]
  summary.candidates = candidates.length

  const { welcomeSenderName, supportEmail } = getBranding()
  const fromName = welcomeSenderName.trim() || undefined

  for (const candidate of candidates) {
    // Logs carry the user id only: the address is PII and the id is enough to
    // find the row.
    const itemLog = log.child({ userId: candidate.user_id })

    const { error: claimError } = await supabase
      .from('user_lifecycle_emails')
      .insert({ user_id: candidate.user_id, email_key: WELCOME_EMAIL_KEY })

    if (claimError) {
      if (claimError.code === '23505') {
        summary.skipped++
        continue
      }
      summary.failed++
      itemLog.error('welcome email claim failed', claimError)
      continue
    }

    const templateData = {
      firstName: firstNameFromFullName(candidate.full_name),
      lang: toLang(candidate.locale),
    }

    try {
      const result = await emailService.sendEmail({
        to: candidate.email,
        subject: generateWelcomeEmailSubject(templateData),
        html: generateWelcomeEmailHtml(templateData),
        text: generateWelcomeEmailText(templateData),
        fromName,
        replyTo: supportEmail,
      })

      if (!result.success) {
        throw new Error(result.error ?? 'email provider rejected the message')
      }

      const { error: markError } = await supabase
        .from('user_lifecycle_emails')
        .update({
          sent_at: new Date().toISOString(),
          provider: result.provider ?? null,
          provider_message_id: result.messageId ?? null,
        })
        .eq('user_id', candidate.user_id)
        .eq('email_key', WELCOME_EMAIL_KEY)

      // The mail is out either way; a failed bookkeeping update must not
      // release the claim (that would resend), so log and count it as sent.
      if (markError) {
        itemLog.warn('welcome email sent but sent_at update failed', markError)
      }

      summary.sent++
      itemLog.info('welcome email sent', { lang: templateData.lang })
    } catch (err) {
      summary.failed++
      itemLog.error('welcome email send failed, releasing claim', err as Error)
      const { error: releaseError } = await supabase
        .from('user_lifecycle_emails')
        .delete()
        .eq('user_id', candidate.user_id)
        .eq('email_key', WELCOME_EMAIL_KEY)
      if (releaseError) {
        itemLog.error('welcome email claim release failed', releaseError)
      }
    }
  }

  return summary
}
