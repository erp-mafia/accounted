/**
 * Failure-alert email for the cloud backup auto-sync.
 *
 * A backup that silently stops running is worse than no backup: the user
 * believes they are covered. The cron calls this when a connection goes
 * needs_reauth (retrying can never succeed) or when several consecutive
 * auto-syncs have failed. Manual syncs never alert: the user is watching.
 *
 * Best-effort by design: an alert failure must never fail the sync loop.
 * Throttling state (`last_alert_at`) lives on the schedule object and is
 * persisted by the caller. The body carries no bookkeeping data, only the
 * company name and the error summary.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { getEmailService } from '@/lib/email/service'
import { createLogger } from '@/lib/logger'

const log = createLogger('cloud-backup-alert')

/** At most one alert email per company per throttle window. */
export const ALERT_THROTTLE_MS = 7 * 24 * 60 * 60 * 1000
/** Consecutive auto-sync failures before a repeated-failures alert fires. */
export const ALERT_FAILURE_THRESHOLD = 3

export type BackupAlertKind = 'needs_reauth' | 'repeated_failures'

export function shouldSendBackupAlert(params: {
  kind: BackupAlertKind
  consecutiveFailures: number
  lastAlertAt: string | null | undefined
  now?: Date
}): boolean {
  const now = params.now ?? new Date()
  if (params.lastAlertAt) {
    const last = new Date(params.lastAlertAt).getTime()
    if (Number.isFinite(last) && now.getTime() - last < ALERT_THROTTLE_MS) {
      return false
    }
  }
  if (params.kind === 'needs_reauth') return true
  return params.consecutiveFailures >= ALERT_FAILURE_THRESHOLD
}

export interface BackupAlertInput {
  companyId: string
  /** The user who configured the schedule: recipient candidate. */
  userId: string
  kind: BackupAlertKind
  consecutiveFailures: number
  errorMessage: string | null
  /** App origin used to build the reconnect link. */
  origin: string
}

export async function sendBackupFailureAlert(
  supabase: SupabaseClient,
  input: BackupAlertInput
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const email = getEmailService()
    if (!email.isConfigured()) return { sent: false, reason: 'email_not_configured' }

    const recipient = await resolveMemberEmail(supabase, input.companyId, input.userId)
    if (!recipient) {
      log.info('no authorised recipient for backup alert', { companyId: input.companyId })
      return { sent: false, reason: 'no_recipient' }
    }

    const companyName = await fetchCompanyName(supabase, input.companyId)
    const link = `${input.origin}/import#cloud-backup`

    let subject: string
    let paragraphs: string[]
    if (input.kind === 'needs_reauth') {
      subject = 'Säkerhetskopieringen till Google Drive är pausad'
      paragraphs = [
        `Den automatiska säkerhetskopieringen för ${companyName} är pausad: åtkomsten till ditt Google-konto har gått ut eller återkallats.`,
        'Koppla om Google Drive för att återuppta säkerhetskopieringen.',
      ]
    } else {
      subject = 'Säkerhetskopieringen till Google Drive misslyckas'
      paragraphs = [
        `Den automatiska säkerhetskopieringen för ${companyName} har misslyckats ${input.consecutiveFailures} nätter i rad.`,
        input.errorMessage ? `Senaste fel: ${input.errorMessage}` : '',
        'Kontrollera anslutningen under Importera/Exportera.',
      ].filter(Boolean)
    }

    const text = [...paragraphs, '', link].join('\n\n')
    const html = [
      ...paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`),
      `<p><a href="${escapeHtml(link)}">Öppna säkerhetskopiering</a></p>`,
    ].join('')

    const result = await email.sendEmail({ to: recipient, subject, text, html })
    if (!result.success) {
      log.warn('backup alert send failed', { companyId: input.companyId, error: result.error })
      return { sent: false, reason: 'send_failed' }
    }
    return { sent: true }
  } catch (err) {
    log.warn('backup alert failed', {
      companyId: input.companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, reason: 'error' }
  }
}

/**
 * The recipient must still be an active member of the company: a schedule
 * owner who has since been removed must not receive alerts for it.
 */
async function resolveMemberEmail(
  supabase: SupabaseClient,
  companyId: string,
  userId: string
): Promise<string | null> {
  const { data: member } = await supabase
    .from('company_members')
    .select('user_id, profiles!inner(email)')
    .eq('company_id', companyId)
    .eq('user_id', userId)
    .maybeSingle()
  if (!member) return null

  type ProfileRef = { email?: string | null } | { email?: string | null }[] | null
  const profiles = (member as { profiles: ProfileRef }).profiles
  const profile = Array.isArray(profiles) ? profiles[0] : profiles
  return profile?.email ?? null
}

async function fetchCompanyName(
  supabase: SupabaseClient,
  companyId: string
): Promise<string> {
  const { data } = await supabase
    .from('company_settings')
    .select('company_name')
    .eq('company_id', companyId)
    .maybeSingle()
  return (data?.company_name as string) || 'ditt företag'
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
