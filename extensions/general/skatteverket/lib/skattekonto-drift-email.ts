import { getEmailService } from '@/lib/email/service'
import { createLogger } from '@/lib/logger'
import { formatDate } from '@/lib/utils'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { EventPayload } from '@/lib/events/types'

const log = createLogger('skattekonto-drift-email')

/**
 * Email handler for `skattekonto.drift_detected`. Notifies the company contact
 * that their cached Skatteverket saldo and the bookkeeping have diverged
 * beyond the configured tolerance — without putting the saldo or drift figures
 * in the email body. The actual numbers are surfaced behind authenticated UI
 * (the dashboard SkattekontoDriftTile) so a misdelivered mail doesn't leak
 * financial figures.
 *
 * Recipient resolution is restricted to active members of the company. A
 * stale company_settings.contact_email that no longer corresponds to a
 * member is never used. Falls back to the syncing user only if they're
 * still an active member.
 *
 * Degrades silently when no email service is registered (e.g. self-hosted
 * installations without Resend configured).
 */
export async function handleSkattekontoDriftDetected(
  payload: EventPayload<'skattekonto.drift_detected'>,
  ctx?: ExtensionContext,
): Promise<void> {
  if (!ctx) {
    log.warn('drift event fired without ctx — cannot resolve recipient', {
      companyId: payload.companyId,
    })
    return
  }

  const email = getEmailService()
  if (!email.isConfigured()) {
    log.info('email service not configured — skipping drift alert', {
      companyId: payload.companyId,
    })
    return
  }

  const recipient = await resolveAuthorisedRecipient(ctx, payload.userId)
  if (!recipient) {
    log.warn('no authorised recipient resolved for drift alert', {
      companyId: payload.companyId,
      userId: payload.userId,
    })
    return
  }

  const fetchedAt = formatDate(new Date(payload.fetchedAt).toISOString())
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://gnubok.se').replace(/\/$/, '')
  const dashboardLink = `${appUrl}/`

  const subject = 'Skattekontot stämmer inte med bokföringen'

  // Body intentionally carries no figures — only a notification that the
  // user should look at the dashboard tile. ISO 27001 A.8.11 / A.5.34: avoid
  // outbound financial data to addresses that may be stale.
  const lines = [
    `Vi har upptäckt en differens mellan ditt skattekonto och bokföringen per ${fetchedAt}.`,
    '',
    'Logga in på gnubok för att se beloppen och granska skattekonto-raderna:',
    dashboardLink,
    '',
    'Vanliga orsaker att differensen syns redan innan en åtgärd behövs:',
    '• Anstånd — saldot förskjuts hos Skatteverket men bokföringen påverkas inte.',
    '• Tidsskillnad — F-skatt debiteras den 12:e men förfaller senare, så Skatteverkets saldo kan ligga före bokföringen.',
    '• Obokförda skattekonto-rader som väntar på din kategorisering.',
    '',
    'Skapa inte en rättelseverifikation innan du har granskat raderna i gnubok.',
  ]
  const text = lines.join('\n')

  const html = `
<p>Vi har upptäckt en differens mellan ditt skattekonto och bokföringen per ${escapeHtml(fetchedAt)}.</p>
<p><a href="${escapeHtml(dashboardLink)}">Logga in på gnubok</a> för att se beloppen och granska skattekonto-raderna.</p>
<p><strong>Vanliga orsaker att differensen syns redan innan en åtgärd behövs:</strong></p>
<ul>
  <li>Anstånd — saldot förskjuts hos Skatteverket men bokföringen påverkas inte.</li>
  <li>Tidsskillnad — F-skatt debiteras den 12:e men förfaller senare, så Skatteverkets saldo kan ligga före bokföringen.</li>
  <li>Obokförda skattekonto-rader som väntar på din kategorisering.</li>
</ul>
<p>Skapa inte en rättelseverifikation innan du har granskat raderna i gnubok.</p>
`.trim()

  try {
    const result = await email.sendEmail({
      to: recipient,
      subject,
      text,
      html,
    })
    if (!result.success) {
      log.warn('drift email send failed', {
        companyId: payload.companyId,
        error: result.error,
      })
    }
  } catch (err) {
    log.error('drift email send threw', {
      companyId: payload.companyId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * Resolve the recipient address for the drift alert and verify it belongs to
 * an active member of the company. A stale company_settings.contact_email
 * (set when a now-revoked admin still owned the company) must never receive
 * a drift notification because the bare existence of one is sensitive
 * financial signal.
 */
async function resolveAuthorisedRecipient(
  ctx: ExtensionContext,
  userId: string,
): Promise<string | null> {
  // 1. Build the set of active member emails for this company. We accept
  //    only addresses that appear here.
  const { data: members } = await ctx.supabase
    .from('company_members')
    .select('user_id, profiles!inner(email)')
    .eq('company_id', ctx.companyId)

  type MemberRow = { user_id: string; profiles: { email?: string | null } | { email?: string | null }[] | null }
  const allowedEmails = new Set<string>()
  for (const m of (members ?? []) as MemberRow[]) {
    const profile = Array.isArray(m.profiles) ? m.profiles[0] : m.profiles
    if (profile?.email) allowedEmails.add(profile.email.toLowerCase())
  }

  if (allowedEmails.size === 0) return null

  // 2. Prefer the configured contact email IF it matches an active member.
  const { data: settings } = await ctx.supabase
    .from('company_settings')
    .select('contact_email')
    .eq('company_id', ctx.companyId)
    .maybeSingle()

  const contactEmail = (settings as { contact_email?: string | null } | null)?.contact_email
  if (contactEmail && allowedEmails.has(contactEmail.toLowerCase())) {
    return contactEmail
  }

  // 3. Fall back to the syncing user's email if they're still a member.
  const { data: profile } = await ctx.supabase
    .from('profiles')
    .select('email')
    .eq('id', userId)
    .maybeSingle()
  const userEmail = (profile as { email?: string | null } | null)?.email
  if (userEmail && allowedEmails.has(userEmail.toLowerCase())) {
    return userEmail
  }

  return null
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
