/**
 * Kvittens confirmation notification (email).
 *
 * The signing happens on Skatteverket's site, and the kvittens is often
 * observed by a background cron long after the user closed the tab. Without
 * an outbound notification the filing confirmation is silent: the user only
 * learns the declaration went through if they come back and look. Both
 * kvittens crons (AGI and VAT) call this after flipping the local state.
 *
 * Email is the delivery channel: it is the one notification surface that is
 * always available (push-notifications is a separate, optional extension and
 * cross-extension imports are not allowed). Deduplication goes through
 * notification_log under type 'skv_kvittens' so a re-observed kvittens never
 * notifies twice: the log row is inserted FIRST as a claim, guarded by a
 * partial unique index on (user_id, reference_id) where notification_type =
 * 'skv_kvittens' (migration 20260712113000), and the email is only sent when
 * this invocation won the insert. A unique violation (23505) means another
 * overlapping cron run already claimed the kvittens.
 *
 * Best-effort by design: a notification failure must never fail the
 * reconciliation that observed the kvittens. The body carries the period and
 * kvittens number but no amounts (same data-minimization stance as the
 * skattekonto drift email).
 */
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getEmailService } from '@/lib/email/service'
import { createLogger } from '@/lib/logger'

const log = createLogger('skv-kvittens-notification')

export interface KvittensNotificationInput {
  companyId: string
  /** The token-owning user: recipient candidate for the email. */
  userId: string
  kind: 'vat' | 'agi'
  /** Human-readable period, e.g. "2026-06" or "202606". */
  period: string
  kvittensnummer: string
  /** Dedup key for the notification log (e.g. declaration id or period key). */
  referenceId: string
}

export async function sendKvittensNotification(
  supabase: SupabaseClient,
  input: KvittensNotificationInput
): Promise<{ sent: boolean; reason?: string }> {
  const referenceUuid = toReferenceUuid(input.referenceId)
  try {
    const email = getEmailService()
    if (!email.isConfigured()) return { sent: false, reason: 'email_not_configured' }

    // Dedup fast path: cheap read that skips the work below on re-observed
    // kvittenser. NOT the enforcement: the claim insert further down is.
    const { data: already } = await supabase
      .from('notification_log')
      .select('id')
      .eq('user_id', input.userId)
      .eq('notification_type', 'skv_kvittens')
      .eq('reference_id', referenceUuid)
      .maybeSingle()
    if (already) return { sent: false, reason: 'duplicate' }

    const recipient = await resolveMemberEmail(supabase, input.companyId, input.userId)
    if (!recipient) {
      log.info('no authorised recipient for kvittens email', { companyId: input.companyId })
      return { sent: false, reason: 'no_recipient' }
    }

    // Claim before sending. The partial unique index on notification_log
    // (user_id, reference_id) where notification_type = 'skv_kvittens' makes
    // this atomic: of two overlapping cron invocations exactly one wins the
    // insert; the loser gets a unique violation and skips the send.
    const { error: claimError } = await supabase.from('notification_log').insert({
      user_id: input.userId,
      company_id: input.companyId,
      notification_type: 'skv_kvittens',
      reference_id: referenceUuid,
      days_before: 0,
      delivery_status: 'sent',
    })
    if (claimError) {
      if (claimError.code === '23505') return { sent: false, reason: 'duplicate' }
      // Without a claim we cannot guarantee single delivery: skip the send
      // (fail closed on the never-twice guarantee) and let a later
      // observation retry.
      log.warn('kvittens claim insert failed', {
        companyId: input.companyId,
        referenceId: input.referenceId,
        error: claimError.message,
      })
      return { sent: false, reason: 'claim_failed' }
    }

    const label = input.kind === 'vat' ? 'Momsdeklarationen' : 'Arbetsgivardeklarationen'
    const labelLower = input.kind === 'vat' ? 'momsdeklarationen' : 'arbetsgivardeklarationen'
    const subject = `${label} för ${input.period} är inlämnad`
    const text = [
      `Din ${labelLower} för ${input.period} har signerats och lämnats in hos Skatteverket.`,
      '',
      `Kvittensnummer: ${input.kvittensnummer}`,
      '',
      'Ingen åtgärd behövs. Kvittensen finns sparad i Accounted.',
    ].join('\n')
    const html = [
      `<p>Din ${labelLower} för ${escapeHtml(input.period)} har signerats och lämnats in hos Skatteverket.</p>`,
      `<p>Kvittensnummer: <strong>${escapeHtml(input.kvittensnummer)}</strong></p>`,
      '<p>Ingen åtgärd behövs. Kvittensen finns sparad i Accounted.</p>',
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
      log.warn('kvittens email send failed', { companyId: input.companyId, error: result.error })
      await releaseClaim(supabase, input.userId, referenceUuid)
      return { sent: false, reason: 'send_failed' }
    }

    return { sent: true }
  } catch (err) {
    log.warn('kvittens notification failed', {
      companyId: input.companyId,
      referenceId: input.referenceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return { sent: false, reason: 'error' }
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * notification_log.reference_id is a uuid column. The AGI cron passes the
 * declaration row id (already a uuid); the VAT cron has no declaration row
 * and passes a composite string key, which Postgres would reject (22P02)
 * before dedup could even happen. Map non-uuid keys to a deterministic
 * uuid-shaped SHA-256 digest so the same kvittens always resolves to the
 * same claim row.
 */
function toReferenceUuid(referenceId: string): string {
  if (UUID_PATTERN.test(referenceId)) return referenceId
  const hex = createHash('sha256').update(referenceId).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Remove a claim whose email never went out, so a later run can retry. */
async function releaseClaim(
  supabase: SupabaseClient,
  userId: string,
  referenceUuid: string
): Promise<void> {
  try {
    await supabase
      .from('notification_log')
      .delete()
      .eq('user_id', userId)
      .eq('notification_type', 'skv_kvittens')
      .eq('reference_id', referenceUuid)
  } catch (err) {
    // A stuck claim only suppresses a retry of this one email: log and move on.
    log.warn('failed to release kvittens claim', {
      userId,
      referenceUuid,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/**
 * The recipient must still be an active member of the company (mirrors the
 * drift-email rule): a token owner who has since been removed from the
 * company must not receive filing confirmations for it.
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

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
