import type { SupabaseClient } from '@supabase/supabase-js'
import { getEmailService } from '@/lib/email/service'
import { createLogger } from '@/lib/logger'
import { resolveMemberEmails } from '@/lib/notifications/member-email'
import { createServiceClient } from '@/lib/supabase/server'
import { formatDate } from '@/lib/utils'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { EventPayload } from '@/lib/events/types'

const log = createLogger('skattekonto-drift-email')

/**
 * Email handler for `skattekonto.drift_detected`. Notifies the company contact
 * that their cached Skatteverket saldo and the bookkeeping have diverged
 * beyond the configured tolerance: without putting the saldo or drift figures
 * in the email body. The actual numbers are surfaced behind authenticated UI
 * (the dashboard SkattekontoDriftTile) so a misdelivered mail doesn't leak
 * financial figures.
 *
 * Service-role client, NOT the registry-built ctx: the only emitter is the
 * nightly cron, whose request carries no user cookies, so the ctx the
 * registry lazily builds there is an anonymous client (or undefined) that
 * RLS turns into "no members, no recipient, no mail". Same rationale as the
 * document-extraction handler and the retired connection-expired handler.
 *
 * Recipient resolution is restricted to active members of the company. A
 * stale company_settings.tax_contact_email that no longer corresponds to a
 * member is never used. Falls back to the syncing user only if they're
 * still an active member.
 *
 * Degrades silently when no email service is registered (e.g. self-hosted
 * installations without Resend configured).
 */
export async function handleSkattekontoDriftDetected(
  payload: EventPayload<'skattekonto.drift_detected'>,
  _ctx?: ExtensionContext,
): Promise<void> {
  const email = getEmailService()
  if (!email.isConfigured()) {
    log.info('email service not configured: skipping drift alert', {
      companyId: payload.companyId,
    })
    return
  }

  const supabase = createServiceClient()
  const recipient = await resolveAuthorisedRecipient(supabase, payload.companyId, payload.userId)
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

  // Body intentionally carries no figures: only a notification that the
  // user should look at the dashboard tile. ISO 27001 A.8.11 / A.5.34: avoid
  // outbound financial data to addresses that may be stale.
  const lines = [
    `Vi har upptäckt en differens mellan ditt skattekonto och bokföringen per ${fetchedAt}.`,
    '',
    'Logga in på Accounted för att se beloppen och granska skattekonto-raderna:',
    dashboardLink,
    '',
    'Vanliga orsaker att differensen syns redan innan en åtgärd behövs:',
    '• Anstånd: saldot förskjuts hos Skatteverket men bokföringen påverkas inte.',
    '• Tidsskillnad: F-skatt debiteras den 12:e men förfaller senare, så Skatteverkets saldo kan ligga före bokföringen.',
    '• Obokförda skattekonto-rader som väntar på din kategorisering.',
    '',
    'Skapa inte en rättelseverifikation innan du har granskat raderna i gnubok.',
  ]
  const text = lines.join('\n')

  const html = `
<p>Vi har upptäckt en differens mellan ditt skattekonto och bokföringen per ${escapeHtml(fetchedAt)}.</p>
<p><a href="${escapeHtml(dashboardLink)}">Logga in på Accounted</a> för att se beloppen och granska skattekonto-raderna.</p>
<p><strong>Vanliga orsaker att differensen syns redan innan en åtgärd behövs:</strong></p>
<ul>
  <li>Anstånd: saldot förskjuts hos Skatteverket men bokföringen påverkas inte.</li>
  <li>Tidsskillnad: F-skatt debiteras den 12:e men förfaller senare, så Skatteverkets saldo kan ligga före bokföringen.</li>
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
 * an active member of the company. A stale company_settings.tax_contact_email
 * (set when a now-revoked admin still owned the company) must never receive
 * a drift notification because the bare existence of one is sensitive
 * financial signal.
 *
 * `tax_contact_email` is the "Kontaktperson för skatteärenden" field in
 * Inställningar > Skatt (components/settings/TaxSettingsForm.tsx): the only
 * place a company routes Skatteverket correspondence to someone other than
 * whoever happened to trigger the sync.
 */
async function resolveAuthorisedRecipient(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
): Promise<string | null> {
  // 1. Build the set of active member emails for this company. We accept
  //    only addresses that appear here. A failed lookup resolves to an empty
  //    map, cancelling the alert: the helper logs it out loud.
  const memberEmails = await resolveMemberEmails(supabase, companyId)
  const allowedEmails = new Set<string>()
  for (const email of memberEmails.values()) allowedEmails.add(email.toLowerCase())

  if (allowedEmails.size === 0) return null

  // 2. Prefer the configured tax contact email IF it matches an active member.
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('tax_contact_email')
    .eq('company_id', companyId)
    .maybeSingle()

  if (settingsError) {
    // Falling back to the syncing user is correct, but doing it without a
    // trace is how a company silently stops getting alerts where it asked
    // for them.
    log.warn('could not read tax contact email: falling back to syncing user', {
      companyId,
      error: settingsError.message,
    })
  }

  const contactEmail = (settings as { tax_contact_email?: string | null } | null)?.tax_contact_email
  if (contactEmail) {
    if (allowedEmails.has(contactEmail.toLowerCase())) {
      return contactEmail
    }
    log.warn('configured tax contact is not an active member: falling back to syncing user', {
      companyId,
    })
  }

  // 3. Fall back to the syncing user's email: present in the map only while
  //    they are still a member.
  const userEmail = memberEmails.get(userId)
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
