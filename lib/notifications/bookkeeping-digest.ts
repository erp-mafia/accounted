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
 * under type 'bookkeeping_digest', guarded by a partial unique index on
 * (user_id, reference_id) (migration 20260831100000). reference_id is a
 * deterministic uuid derived from (company, digest date), so overlapping cron
 * invocations race on the insert and exactly one wins. The claim is
 * recoverable: it is inserted as delivery_status 'pending', flipped to 'sent'
 * only after the provider accepted the mail, and a 'pending' claim older than
 * STALE_CLAIM_MS (a run that died before sending, or a send that failed) can
 * be atomically taken over by a later run, so an interruption never silently
 * swallows that day's digest.
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

/**
 * A 'pending' claim older than this is considered abandoned (the run that
 * inserted it died before sending) and may be taken over by a later run.
 * The cron is daily, so anything measured in minutes is safely stale.
 */
const STALE_CLAIM_MS = 15 * 60 * 1000

/**
 * Max ids per PostgREST .in() filter: ids travel in the GET query string,
 * and an unchunked list 414s past proxy URL limits (same limit and
 * rationale as lib/worklist/categories.ts).
 */
const IN_CLAUSE_CHUNK = 150

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
 * Count what arrived in the window and is still unhandled, using the same
 * anchors as the worklist counts (lib/worklist/categories.ts). Transactions:
 * created in the window, not yet booked (journal_entry_id anchor only; rows
 * junction-linked via samlingsverifikat are a rounding error a few hours
 * after import), not marked private, and not ignored. Inbox items: created
 * in the window and not yet terminal on any of the three markers
 * (supplier invoice created, booked directly, or matched to a transaction;
 * status stays 'received' in all three cases).
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
      .not('is_business', 'is', false)
      .eq('is_ignored', false),
    supabase
      .from('invoice_inbox_items')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .gte('created_at', sinceIso)
      .in('status', ['received', 'processing'])
      .is('created_supplier_invoice_id', null)
      .is('created_journal_entry_id', null)
      .is('matched_transaction_id', null),
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
  const memberships: Array<{ user_id: string; company_id: string }> = []
  for (const idChunk of chunk(userIds, IN_CLAUSE_CHUNK)) {
    const page = await fetchAllRows<{ user_id: string; company_id: string }>(({ from, to }) =>
      supabase
        .from('company_members')
        .select('user_id, company_id')
        .in('user_id', idChunk)
        // (company_id, user_id) is unique per membership: stable total order
        // for range paging.
        .order('company_id', { ascending: true })
        .order('user_id', { ascending: true })
        .range(from, to)
    )
    memberships.push(...page)
  }

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
  const rawCompanyName = (company as { name?: string } | null)?.name ?? null
  // The name reaches the Subject header: sanitize against header injection.
  const companyName = rawCompanyName ? sanitizeHeaderText(rawCompanyName) || null : null

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

    const claim = await acquireClaim(supabase, userId, input.companyId, referenceUuid)
    if (claim === 'duplicate') {
      out.skippedDuplicate++
      continue
    }
    if (claim === 'error') {
      // Without a claim we cannot guarantee once-per-day: fail closed.
      out.failed++
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
      // The claim stays 'pending': a later run takes it over once stale.
      out.failed++
      log.warn('digest email send threw', {
        companyId: input.companyId,
        error: err instanceof Error ? err.message : String(err),
      })
      continue
    }
    if (!sendResult.success) {
      out.failed++
      log.warn('digest email send failed', {
        companyId: input.companyId,
        error: sendResult.error,
      })
      continue
    }
    await markClaimSent(supabase, userId, referenceUuid)
    out.sent++
  }

  return out
}

type ClaimOutcome = 'acquired' | 'duplicate' | 'error'

/**
 * Acquire the once-per-day send claim. The insert (delivery_status
 * 'pending') is made atomic by the partial unique index on
 * (user_id, reference_id) for this notification_type; the loser of two
 * overlapping runs gets 23505. A 'pending' claim whose sent_at lease is
 * older than STALE_CLAIM_MS belonged to a run that died before sending (or
 * whose send failed): it is taken over by atomically renewing the lease,
 * conditioned on the row still being the same stale 'pending', so exactly
 * one contender wins.
 */
async function acquireClaim(
  supabase: SupabaseClient,
  userId: string,
  companyId: string,
  referenceUuid: string
): Promise<ClaimOutcome> {
  const { error: claimError } = await supabase.from('notification_log').insert({
    user_id: userId,
    company_id: companyId,
    notification_type: 'bookkeeping_digest',
    reference_id: referenceUuid,
    days_before: 0,
    delivery_status: 'pending',
  })
  if (!claimError) return 'acquired'
  if (claimError.code !== '23505') {
    log.warn('digest claim insert failed', { companyId, error: claimError.message })
    return 'error'
  }

  const { data: existing, error: readError } = await supabase
    .from('notification_log')
    .select('id, delivery_status, sent_at')
    .eq('user_id', userId)
    .eq('notification_type', 'bookkeeping_digest')
    .eq('reference_id', referenceUuid)
    .maybeSingle()
  if (readError || !existing) return 'duplicate'
  const row = existing as { id: string; delivery_status: string; sent_at: string | null }
  if (row.delivery_status !== 'pending') return 'duplicate'
  const staleCutoffIso = new Date(Date.now() - STALE_CLAIM_MS).toISOString()
  if (row.sent_at && row.sent_at > staleCutoffIso) return 'duplicate'

  const { data: taken, error: takeError } = await supabase
    .from('notification_log')
    .update({ sent_at: new Date().toISOString() })
    .eq('id', row.id)
    .eq('delivery_status', 'pending')
    .lte('sent_at', staleCutoffIso)
    .select('id')
  if (takeError || !taken || taken.length === 0) return 'duplicate'
  return 'acquired'
}

/**
 * Flip the claim to 'sent' after the provider accepted the mail. Best-effort:
 * if this update fails the claim stays 'pending' and a stale takeover could
 * resend, which is the accepted trade against silently losing the digest.
 */
async function markClaimSent(
  supabase: SupabaseClient,
  userId: string,
  referenceUuid: string
): Promise<void> {
  const { error } = await supabase
    .from('notification_log')
    .update({ delivery_status: 'sent', sent_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('notification_type', 'bookkeeping_digest')
    .eq('reference_id', referenceUuid)
  if (error) {
    log.warn('could not mark digest claim sent', { userId, referenceUuid, error: error.message })
  }
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

/** Split ids into .in()-safe chunks (see IN_CLAUSE_CHUNK). */
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Company names are user-controlled and reach the Subject header: strip
 * CR/LF and other control characters so the value can never smuggle extra
 * mail headers.
 */
function sanitizeHeaderText(input: string): string {
  // eslint-disable-next-line no-control-regex
  return input.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
