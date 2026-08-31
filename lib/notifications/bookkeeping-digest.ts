/**
 * Daily "nytt att bokföra" email digest.
 *
 * Users asked for an email when there is new work to book: bank transactions
 * that synced overnight and documents that landed in the inbox. The digest is
 * strictly opt-in (notification_settings.email_digest_enabled, default false)
 * and runs daily after the 05:00 bank sync so the night's imports are counted
 * the same morning.
 *
 * One email per user per company per day: dedup goes through notification_log
 * under type 'bookkeeping_digest' with the same claim-then-send mechanism as
 * the kvittens email (migration 20260831100000). reference_id is a
 * deterministic uuid derived from (company, digest date), so overlapping cron
 * invocations race on the insert and exactly one wins.
 *
 * The body carries counts only, never amounts or counterparties: the mere
 * existence of company mail is sensitive financial signal, so the details
 * live behind login (same data-minimization stance as the skattekonto drift
 * and kvittens emails).
 *
 * Best-effort by design: a digest failure must never fail the cron run for
 * other users or companies.
 */
import { createHash } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getEmailService } from '@/lib/email/service'
import { getSenderForBrand, getBaseUrlForBrand } from '@/lib/email/brand-sender'
import { resolveBrandForCompany } from '@/lib/branding/resolve'
import { createLogger } from '@/lib/logger'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

const log = createLogger('bookkeeping-digest')

/** The digest counts changes in the last 24h: one cron cadence back. */
const WINDOW_MS = 24 * 60 * 60 * 1000

export interface DigestCounts {
  newTransactions: number
  newInboxItems: number
}

export interface DigestRunSummary {
  optedInUsers: number
  companiesConsidered: number
  sent: number
  skippedEmpty: number
  skippedDuplicate: number
  failed: number
}

/**
 * Count what arrived in the window and is still unhandled. Transactions:
 * created in the window, not yet booked (journal_entry_id anchor only; rows
 * junction-linked via samlingsverifikat are a rounding error a few hours
 * after import) and not marked private. Inbox items: created in the window
 * and still in an unhandled status.
 */
export async function countNewToBook(
  supabase: SupabaseClient,
  companyId: string,
  sinceIso: string
): Promise<DigestCounts> {
  const [txHead, inboxHead] = await Promise.all([
    supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('created_at', sinceIso)
      .is('journal_entry_id', null)
      .not('is_business', 'is', false),
    supabase
      .from('invoice_inbox_items')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('created_at', sinceIso)
      // Not yet failed, and not yet turned into a supplier invoice: the
      // created_supplier_invoice_id marker is what the inbox UI treats as
      // "processed" (status stays 'received').
      .in('status', ['received', 'processing'])
      .is('created_supplier_invoice_id', null),
  ])
  if (txHead.error) throw new Error(`transactions count failed: ${txHead.error.message}`)
  if (inboxHead.error) throw new Error(`inbox count failed: ${inboxHead.error.message}`)
  return {
    newTransactions: txHead.count ?? 0,
    newInboxItems: inboxHead.count ?? 0,
  }
}

/**
 * Run the digest for every opted-in user. Requires a SERVICE-ROLE client:
 * both the settings sweep and the profile email lookups cross user
 * boundaries that RLS would silently empty out.
 */
export async function runBookkeepingDigest(
  supabase: SupabaseClient,
  now: Date
): Promise<DigestRunSummary> {
  const summary: DigestRunSummary = {
    optedInUsers: 0,
    companiesConsidered: 0,
    sent: 0,
    skippedEmpty: 0,
    skippedDuplicate: 0,
    failed: 0,
  }

  const email = getEmailService()
  if (!email.isConfigured()) {
    log.info('bookkeeping digest skipped: email service not configured')
    return summary
  }

  const optedIn = await fetchAllRows<{ user_id: string }>(({ from, to }) =>
    supabase
      .from('notification_settings')
      .select('user_id')
      .eq('email_digest_enabled', true)
      .order('user_id', { ascending: true })
      .range(from, to)
  )
  summary.optedInUsers = optedIn.length
  if (optedIn.length === 0) return summary

  const userIds = optedIn.map((r) => r.user_id)
  const memberships = await fetchAllRows<{ user_id: string; company_id: string }>(({ from, to }) =>
    supabase
      .from('company_members')
      .select('user_id, company_id')
      .in('user_id', userIds)
      // (company_id, user_id) is unique per membership: stable total order
      // for range paging.
      .order('company_id', { ascending: true })
      .order('user_id', { ascending: true })
      .range(from, to)
  )

  const usersByCompany = new Map<string, string[]>()
  for (const m of memberships) {
    if (!m.user_id || !m.company_id) continue
    const list = usersByCompany.get(m.company_id) ?? []
    list.push(m.user_id)
    usersByCompany.set(m.company_id, list)
  }
  summary.companiesConsidered = usersByCompany.size

  const sinceIso = new Date(now.getTime() - WINDOW_MS).toISOString()
  const digestDate = now.toISOString().slice(0, 10)

  for (const [companyId, companyUserIds] of usersByCompany) {
    try {
      const counts = await countNewToBook(supabase, companyId, sinceIso)
      if (counts.newTransactions === 0 && counts.newInboxItems === 0) {
        summary.skippedEmpty += companyUserIds.length
        continue
      }
      const result = await sendDigestForCompany(supabase, {
        companyId,
        userIds: companyUserIds,
        counts,
        digestDate,
      })
      summary.sent += result.sent
      summary.skippedDuplicate += result.skippedDuplicate
      summary.failed += result.failed
    } catch (err) {
      summary.failed += companyUserIds.length
      log.warn('bookkeeping digest failed for company', {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return summary
}

interface CompanyDigestInput {
  companyId: string
  userIds: string[]
  counts: DigestCounts
  digestDate: string
}

async function sendDigestForCompany(
  supabase: SupabaseClient,
  input: CompanyDigestInput
): Promise<{ sent: number; skippedDuplicate: number; failed: number }> {
  const out = { sent: 0, skippedDuplicate: 0, failed: 0 }
  const email = getEmailService()

  const { data: company } = await supabase
    .from('companies')
    .select('name')
    .eq('id', input.companyId)
    .maybeSingle()
  const companyName = (company as { name?: string } | null)?.name ?? null

  // One brand resolution per company; sender identity and link base follow
  // the company's brand (white-label rule: mail goes out in the brand of the
  // company it concerns).
  const brand = await resolveBrandForCompany(input.companyId)
  const sender = getSenderForBrand(brand)
  const baseUrl = getBaseUrlForBrand(brand)

  // The recipient allowlist is the set of active members: an opted-in user
  // removed from the company must not keep receiving its digest.
  const memberEmails = await resolveCompanyMemberEmails(supabase, input.companyId, input.userIds)

  const referenceUuid = toReferenceUuid(
    `bookkeeping_digest:${input.companyId}:${input.digestDate}`
  )

  for (const userId of input.userIds) {
    const recipient = memberEmails.get(userId)
    if (!recipient) continue

    // Claim before sending: the partial unique index on notification_log
    // (user_id, reference_id) where notification_type = 'bookkeeping_digest'
    // makes this atomic; the loser of two overlapping cron runs gets 23505.
    const { error: claimError } = await supabase.from('notification_log').insert({
      user_id: userId,
      company_id: input.companyId,
      notification_type: 'bookkeeping_digest',
      reference_id: referenceUuid,
      days_before: 0,
      delivery_status: 'sent',
    })
    if (claimError) {
      if (claimError.code === '23505') {
        out.skippedDuplicate++
      } else {
        // Without a claim we cannot guarantee once-per-day: fail closed.
        log.warn('digest claim insert failed', {
          companyId: input.companyId,
          error: claimError.message,
        })
        out.failed++
      }
      continue
    }

    const message = buildDigestEmail({
      companyName,
      counts: input.counts,
      baseUrl,
      appName: brand?.appName ?? 'Accounted',
    })

    let sendResult: Awaited<ReturnType<typeof email.sendEmail>>
    try {
      sendResult = await email.sendEmail({
        to: recipient,
        subject: message.subject,
        text: message.text,
        html: message.html,
        ...(sender.fromName ? { fromName: sender.fromName } : {}),
        ...(sender.fromAddress ? { fromAddress: sender.fromAddress } : {}),
        ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
      })
    } catch (err) {
      await releaseClaim(supabase, userId, referenceUuid)
      out.failed++
      log.warn('digest email send threw', {
        companyId: input.companyId,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (!sendResult.success) {
      await releaseClaim(supabase, userId, referenceUuid)
      out.failed++
      log.warn('digest email send failed', {
        companyId: input.companyId,
        error: sendResult.error,
      })
      continue
    }
    out.sent++
  }

  return out
}

interface DigestEmailContent {
  subject: string
  text: string
  html: string
}

/** Exported for tests: counts only, no amounts or counterparties. */
export function buildDigestEmail(input: {
  companyName: string | null
  counts: DigestCounts
  baseUrl: string
  appName: string
}): DigestEmailContent {
  const inCompany = input.companyName ? ` i ${input.companyName}` : ''
  const subject = `Nytt att bokföra${inCompany}`

  const lines: string[] = []
  if (input.counts.newTransactions > 0) {
    lines.push(
      input.counts.newTransactions === 1
        ? '1 ny banktransaktion att bokföra'
        : `${input.counts.newTransactions} nya banktransaktioner att bokföra`
    )
  }
  if (input.counts.newInboxItems > 0) {
    lines.push(
      input.counts.newInboxItems === 1
        ? '1 nytt underlag i inkorgen'
        : `${input.counts.newInboxItems} nya underlag i inkorgen`
    )
  }

  const intro = `Sedan igår har det kommit in nytt${inCompany ? ` till ${input.companyName}` : ''}:`
  const text = [
    intro,
    '',
    ...lines.map((l) => `- ${l}`),
    '',
    `Logga in för att bokföra: ${input.baseUrl}`,
    '',
    `Du får det här mejlet för att du har slagit på daglig sammanfattning i ${input.appName}. Stäng av under Inställningar > Aviseringar.`,
  ].join('\n')

  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    `<ul>${lines.map((l) => `<li>${escapeHtml(l)}</li>`).join('')}</ul>`,
    `<p><a href="${escapeHtml(input.baseUrl)}">Logga in för att bokföra</a></p>`,
    `<p style="color:#6b7280;font-size:12px">Du får det här mejlet för att du har slagit på daglig sammanfattning i ${escapeHtml(input.appName)}. Stäng av under Inställningar &gt; Aviseringar.</p>`,
  ].join('')

  return { subject, text, html }
}

/**
 * Member allowlist + emails for the given users, batched (not per-user
 * round-trips like resolveMemberEmail). Same two-step shape as
 * lib/notifications/member-email.ts and for the same reason: there is no FK
 * from company_members.user_id to profiles, so a PostgREST embed 400s.
 */
async function resolveCompanyMemberEmails(
  supabase: SupabaseClient,
  companyId: string,
  userIds: string[]
): Promise<Map<string, string>> {
  const emails = new Map<string, string>()
  const { data: members, error: memberError } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', companyId)
    .in('user_id', userIds)
  if (memberError) {
    log.warn('could not read company members for digest recipients', {
      companyId,
      error: memberError.message,
    })
    return emails
  }
  const memberIds = (members ?? [])
    .map((m) => (m as { user_id: string | null }).user_id)
    .filter((id): id is string => typeof id === 'string')
  if (memberIds.length === 0) return emails

  const { data: profiles, error: profileError } = await supabase
    .from('profiles')
    .select('id, email')
    .in('id', memberIds)
  if (profileError) {
    log.warn('could not read profile emails for digest recipients', {
      companyId,
      error: profileError.message,
    })
    return emails
  }
  for (const row of (profiles ?? []) as Array<{ id: string; email: string | null }>) {
    if (row.email) emails.set(row.id, row.email)
  }
  return emails
}

/**
 * notification_log.reference_id is a uuid column, but the digest's natural
 * key is (company, date). Same deterministic SHA-256-to-uuid mapping as the
 * kvittens notification.
 */
function toReferenceUuid(referenceKey: string): string {
  const hex = createHash('sha256').update(referenceKey).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`
}

/** Remove a claim whose email never went out, so tomorrow is unaffected and a retried run can resend. */
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
      .eq('notification_type', 'bookkeeping_digest')
      .eq('reference_id', referenceUuid)
  } catch (err) {
    log.warn('failed to release digest claim', {
      userId,
      referenceUuid,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
