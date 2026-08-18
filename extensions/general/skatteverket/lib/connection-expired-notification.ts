/**
 * Connection-expired notification (email).
 *
 * Handler for `skattekonto.connection.expired`: emitted by syncSkattekonto
 * when a terminal auth error (REFRESH_EXHAUSTED / SESSION_EXPIRED /
 * TOKEN_CORRUPTED) kills the personal SKV token. Before this handler the
 * event was emitted but unconsumed: the needs_reconsent state was only
 * visible on the settings panel, which users have no reason to revisit, so
 * a dead connection silently meant "skattekonto never syncs again". Prod
 * accumulated ~70 companies in exactly that state.
 *
 * Email is the delivery channel (same rationale as kvittens-notification:
 * push-notifications is a separate, optional extension and cross-extension
 * imports are not allowed). The recipient is the token OWNER: only they can
 * redo the BankID consent, so a company contact address would be actionable
 * for the wrong person. The owner must still be an active member of the
 * company.
 *
 * Deduplication: one email per consent episode. The reference key is derived
 * from (userId, token.created_at): a reconnect creates a new token row with
 * a new created_at, so a later expiry notifies again, while the nightly cron
 * re-observing the same dead token stays silent. Claim-first through
 * notification_log under type 'skv_connection_expired', made atomic by the
 * partial unique index in migration 20260720090000 (mirrors the kvittens
 * pattern).
 *
 * Best-effort by contract: a notification failure must never fail the sync
 * (or cron) that observed the expiry. The body carries no financial data.
 */
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { EventPayload } from '@/lib/events/types'
import { createServiceClient } from '@/lib/supabase/server'
import { getEmailService } from '@/lib/email/service'
import { createLogger } from '@/lib/logger'

const log = createLogger('skv-connection-expired-notification')

export async function handleSkattekontoConnectionExpired(
  payload: EventPayload<'skattekonto.connection.expired'>,
): Promise<void> {
  // Service-role client, NOT the registry-built ctx: the primary emitter is
  // the nightly cron, whose request carries no user cookies, so the ctx the
  // registry lazily builds there is an anonymous client that RLS turns into
  // "no token, no member, nothing to do". Same rationale as the
  // document-extraction handler.
  const supabase = createServiceClient()
  await sendConnectionExpiredNotification(supabase, {
    companyId: payload.companyId,
    userId: payload.userId,
  })
}

export interface ConnectionExpiredInput {
  companyId: string
  /** The token-owning user: the only person who can redo the BankID consent. */
  userId: string
}

export async function sendConnectionExpiredNotification(
  supabase: SupabaseClient,
  input: ConnectionExpiredInput,
): Promise<{ sent: boolean; reason?: string }> {
  try {
    const email = getEmailService()
    if (!email.isConfigured()) return { sent: false, reason: 'email_not_configured' }

    // Episode key: the token row's created_at. No token row means nothing to
    // reconnect (already disconnected): skip. Rows are per (user, company):
    // without the company filter a multi-company operator's second row made
    // maybeSingle() error out and the email was never sent.
    const { data: token } = await supabase
      .from('skatteverket_tokens')
      .select('created_at')
      .eq('user_id', input.userId)
      .eq('company_id', input.companyId)
      .maybeSingle()
    const tokenCreatedAt = (token as { created_at?: string | null } | null)?.created_at
    if (!tokenCreatedAt) return { sent: false, reason: 'no_token' }

    const referenceUuid = toReferenceUuid(
      `skv-connection-expired|${input.userId}|${tokenCreatedAt}`,
    )

    // Dedup fast path: cheap read that skips the work below on re-observed
    // expiries. NOT the enforcement: the claim insert further down is.
    const { data: already } = await supabase
      .from('notification_log')
      .select('id')
      .eq('user_id', input.userId)
      .eq('notification_type', 'skv_connection_expired')
      .eq('reference_id', referenceUuid)
      .maybeSingle()
    if (already) return { sent: false, reason: 'duplicate' }

    const recipient = await resolveMemberEmail(supabase, input.companyId, input.userId)
    if (!recipient) {
      log.info('no authorised recipient for connection-expired email', {
        companyId: input.companyId,
      })
      return { sent: false, reason: 'no_recipient' }
    }

    // Claim before sending: the partial unique index on notification_log
    // (user_id, reference_id) where notification_type =
    // 'skv_connection_expired' makes this atomic. Of two overlapping
    // emitters exactly one wins the insert; the loser gets a unique
    // violation and skips the send.
    const { error: claimError } = await supabase.from('notification_log').insert({
      user_id: input.userId,
      company_id: input.companyId,
      notification_type: 'skv_connection_expired',
      reference_id: referenceUuid,
      days_before: 0,
      delivery_status: 'sent',
    })
    if (claimError) {
      if (claimError.code === '23505') return { sent: false, reason: 'duplicate' }
      // Without a claim we cannot guarantee single delivery: skip the send
      // (fail closed on the never-twice guarantee) and let a later
      // observation retry.
      log.warn('connection-expired claim insert failed', {
        companyId: input.companyId,
        error: claimError.message,
      })
      return { sent: false, reason: 'claim_failed' }
    }

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL || 'https://gnubok.se').replace(/\/$/, '')
    const settingsLink = `${appUrl}/settings/tax`

    const subject = 'Anslutningen till Skatteverket behöver förnyas'
    const text = [
      'Din anslutning till Skatteverket har gått ut. Hämtningen av skattekontots saldo och transaktioner är pausad tills du ansluter igen.',
      '',
      'Så här återansluter du:',
      `1. Gå till Inställningar > Skatt i Accounted: ${settingsLink}`,
      '2. Klicka på "Anslut igen" och legitimera dig med BankID.',
      '3. Godkänn alla behörigheter på Skatteverkets samtyckessida.',
      '',
      'När du anslutit hämtas skattekontot direkt.',
    ].join('\n')
    const html = [
      '<p>Din anslutning till Skatteverket har gått ut. Hämtningen av skattekontots saldo och transaktioner är pausad tills du ansluter igen.</p>',
      '<p><strong>Så här återansluter du:</strong></p>',
      '<ol>',
      `<li>Gå till <a href="${escapeHtml(settingsLink)}">Inställningar &gt; Skatt i Accounted</a>.</li>`,
      '<li>Klicka på "Anslut igen" och legitimera dig med BankID.</li>',
      '<li>Godkänn alla behörigheter på Skatteverkets samtyckessida.</li>',
      '</ol>',
      '<p>När du anslutit hämtas skattekontot direkt.</p>',
    ].join('')

    let result: Awaited<ReturnType<typeof email.sendEmail>>
    try {
      result = await email.sendEmail({ to: recipient, subject, text, html })
    } catch (sendErr) {
      // Release the claim so a later observation can retry the send.
      await releaseClaim(supabase, input.userId, referenceUuid)
      throw sendErr
    }
    if (!result.success) {
      log.warn('connection-expired email send failed', {
        companyId: input.companyId,
        error: result.error,
      })
      await releaseClaim(supabase, input.userId, referenceUuid)
      return { sent: false, reason: 'send_failed' }
    }

    return { sent: true }
  } catch (err) {
    log.warn('connection-expired notification failed', {
      companyId: input.companyId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, reason: 'error' }
  }
}

/**
 * notification_log.reference_id is a uuid column; the episode key is a
 * composite string. Map it to a deterministic uuid-shaped SHA-256 digest so
 * the same episode always resolves to the same claim row (same approach as
 * kvittens-notification).
 */
function toReferenceUuid(referenceKey: string): string {
  const hex = createHash('sha256').update(referenceKey).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Remove a claim whose email never went out, so a later run can retry. */
async function releaseClaim(
  supabase: SupabaseClient,
  userId: string,
  referenceUuid: string,
): Promise<void> {
  try {
    await supabase
      .from('notification_log')
      .delete()
      .eq('user_id', userId)
      .eq('notification_type', 'skv_connection_expired')
      .eq('reference_id', referenceUuid)
  } catch (err) {
    // A stuck claim only suppresses a retry of this one email: log and move on.
    log.warn('failed to release connection-expired claim', {
      userId,
      referenceUuid,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * The recipient must still be an active member of the company (mirrors the
 * kvittens rule): a token owner who has since been removed from the company
 * must not receive connection nudges for it.
 */
async function resolveMemberEmail(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
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

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
