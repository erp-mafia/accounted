/**
 * Peppol health: make a Peppol problem reach a person.
 *
 * Every Peppol failure mode used to be silent. This check runs at the end of
 * the outbound status cron (after the poll has recorded what the access
 * point said) and looks for four problems:
 *
 *   delivery_failed       the access point refused the invoice for good
 *                         (status 'failed', terminal within 7 days)
 *   delivery_stuck        handed over, then nothing: 'submitting' or
 *                         'submission_accepted' with a provider submission id
 *                         for over an hour, submitted within 45 days (the
 *                         poll's own horizon). Also what a poll that keeps
 *                         failing on a response shape, or a provider outage,
 *                         looks like from here.
 *   delivery_retry_stuck  a retryable failure nobody retried for an hour, on
 *                         an invoice that was issued anyway (sent or overdue),
 *                         created within 45 days
 *   inbound_unrouted      a received document left 'unrouted' or 'failed' for
 *                         over 30 minutes, created within 30 days
 *
 * Each problem is claimed in peppol_alerts with INSERT ... ON CONFLICT
 * (kind, ref_id) DO NOTHING RETURNING; only what this run claimed is
 * reported, so a problem is reported once however many runs see it, and two
 * overlapping runs never both report it. The team gets one digest per run
 * listing every new problem; the sender of a failed invoice gets a mail of
 * their own. The digest goes first: if it fails, every claim of the run is
 * released and no sender is mailed, so the next run retries the lot without
 * mailing a customer twice. A sender mail that fails releases its own claim.
 * Without an e-mail service nothing is claimed, so the backlog is reported
 * once one is configured.
 *
 * Every run has a fixed budget, because inbound documents are supplied from
 * outside and a flood must not turn into an unbounded scan or mail: each rule
 * reads at most SCAN_LIMIT_PER_KIND rows (newest first), problems an earlier
 * run claimed are skipped before claiming, and at most MAX_NEW_PER_RUN new
 * problems (oldest first) are claimed and mailed per run. The rest wait for
 * the next run, 15 minutes later, and are counted as deferred.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBranding } from '@/lib/branding/service'
import { getBaseUrlForBrand, getSenderForCompany } from '@/lib/email/brand-sender'
import { getEmailService, type EmailService } from '@/lib/email/service'
import { escapeHtml, sanitizeSubjectLine } from '@/lib/email/user-text'
import { createLogger, type Logger } from '@/lib/logger'
import { resolveMemberEmail } from '@/lib/notifications/member-email'
import { getSupportRecipientEmail } from '@/lib/support'

export const PEPPOL_ALERT_KINDS = [
  'delivery_failed',
  'delivery_stuck',
  'delivery_retry_stuck',
  'inbound_unrouted',
] as const
export type PeppolAlertKind = (typeof PEPPOL_ALERT_KINDS)[number]

const MINUTE_MS = 60 * 1000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS

const FAILED_LOOKBACK_MS = 7 * DAY_MS
const STUCK_AFTER_MS = HOUR_MS
const DELIVERY_LOOKBACK_MS = 45 * DAY_MS
const INBOUND_STUCK_AFTER_MS = 30 * MINUTE_MS
const INBOUND_LOOKBACK_MS = 30 * DAY_MS

/** Rows each rule reads per run, newest first. */
const SCAN_LIMIT_PER_KIND = 500
/** New problems claimed and mailed per run; the rest wait for the next run. */
const MAX_NEW_PER_RUN = 50

/** Max ids per PostgREST .in() filter: 150 UUIDs stay well under proxy URL limits. */
const IN_CLAUSE_CHUNK = 150
/** Provider texts can run long; the mails carry the start of one. */
const DETAIL_MAX = 300

/**
 * A delivery as the three delivery rules select it. The select string is
 * spelled out in each query rather than shared, so the schema guard
 * (tests/schema) can check every column.
 */
interface DeliveryRow {
  id: string
  company_id: string
  invoice_id: string
  user_id: string
  status: string
  status_at: string
  status_detail: string | null
  terminal_at: string | null
  created_at: string
  invoice: {
    invoice_number: string | null
    status: string
    customer: { name: string | null } | null
  } | null
}

/**
 * The row as fetched. PostgREST answers a to-one embed with an object, but
 * supabase-js without generated types calls it an array, so the embed is read
 * as unknown and cast once here (the batch-operations pattern).
 */
type FetchedDeliveryRow = Omit<DeliveryRow, 'invoice'> & { invoice: unknown }

const asDeliveryRow = (row: FetchedDeliveryRow): DeliveryRow => ({
  ...row,
  invoice: (row.invoice ?? null) as DeliveryRow['invoice'],
})

interface InboundRow {
  id: string
  company_id: string | null
  provider_document_id: string
  document_type: string
  status: string
  recipient_scheme: string | null
  recipient_identifier: string | null
  sender_name: string | null
  last_error: string | null
  created_at: string
}

interface PeppolProblem {
  kind: PeppolAlertKind
  refId: string
  companyId: string | null
  /** When the problem state began: the age the digest shows. */
  since: string
  detail: string | null
  delivery?: DeliveryRow
  inbound?: InboundRow
}

export interface PeppolHealthSummary {
  /** Set when the check did nothing this run. */
  skipped: 'email_not_configured' | null
  /** Problems the rules see, reported before or not. */
  found: Record<PeppolAlertKind, number>
  /** Problems claimed (reported for the first time) this run. */
  claimed: Record<PeppolAlertKind, number>
  digest: 'sent' | 'failed' | 'none'
  senderMails: { sent: number; failed: number; noRecipient: number }
  /** Claims deleted after a failed mail; the next run reports them again. */
  released: number
  /** New problems over this run's budget, left for the next run. */
  deferred: number
}

function perKind(): Record<PeppolAlertKind, number> {
  return { delivery_failed: 0, delivery_stuck: 0, delivery_retry_stuck: 0, inbound_unrouted: 0 }
}

function emptySummary(): PeppolHealthSummary {
  return {
    skipped: null,
    found: perKind(),
    claimed: perKind(),
    digest: 'none',
    senderMails: { sent: 0, failed: 0, noRecipient: 0 },
    released: 0,
    deferred: 0,
  }
}

const problemKey = (kind: string, refId: string) => `${kind}:${refId}`

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function clip(text: string | null | undefined): string | null {
  const trimmed = text?.trim()
  if (!trimmed) return null
  return trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX)}...` : trimmed
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/** One bounded read; a failed read throws, like the rest of the rules. */
async function rows<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>, what: string): Promise<T[]> {
  const { data, error } = await query
  if (error) throw new Error(`Failed to read ${what}: ${error.message}`)
  return (data ?? []) as T[]
}

async function findProblems(service: SupabaseClient, now: Date): Promise<PeppolProblem[]> {
  const at = (msAgo: number) => new Date(now.getTime() - msAgo).toISOString()

  const failed = await rows<FetchedDeliveryRow>(
    service
      .from('peppol_deliveries')
      .select('id, company_id, invoice_id, user_id, status, status_at, status_detail, terminal_at, created_at, invoice:invoices!inner(invoice_number, status, customer:customers(name))')
      .eq('status', 'failed')
      .gte('terminal_at', at(FAILED_LOOKBACK_MS))
      .order('terminal_at', { ascending: false })
      .limit(SCAN_LIMIT_PER_KIND),
    'failed deliveries',
  )
  const stuck = await rows<FetchedDeliveryRow>(
    service
      .from('peppol_deliveries')
      .select('id, company_id, invoice_id, user_id, status, status_at, status_detail, terminal_at, created_at, invoice:invoices!inner(invoice_number, status, customer:customers(name))')
      .in('status', ['submitting', 'submission_accepted'])
      .not('provider_submission_id', 'is', null)
      .lt('status_at', at(STUCK_AFTER_MS))
      .gte('submitted_at', at(DELIVERY_LOOKBACK_MS))
      .order('status_at', { ascending: false })
      .limit(SCAN_LIMIT_PER_KIND),
    'stuck deliveries',
  )
  const retryStuck = await rows<FetchedDeliveryRow>(
    service
      .from('peppol_deliveries')
      .select('id, company_id, invoice_id, user_id, status, status_at, status_detail, terminal_at, created_at, invoice:invoices!inner(invoice_number, status, customer:customers(name))')
      .eq('status', 'retryable_failure')
      .lt('status_at', at(STUCK_AFTER_MS))
      .gte('created_at', at(DELIVERY_LOOKBACK_MS))
      .in('invoice.status', ['sent', 'overdue'])
      .order('status_at', { ascending: false })
      .limit(SCAN_LIMIT_PER_KIND),
    'retryable deliveries',
  )
  const inbound = await rows<InboundRow>(
    service
      .from('peppol_inbound_documents')
      .select('id, company_id, provider_document_id, document_type, status, recipient_scheme, recipient_identifier, sender_name, last_error, created_at')
      .in('status', ['unrouted', 'failed'])
      .lt('created_at', at(INBOUND_STUCK_AFTER_MS))
      .gte('created_at', at(INBOUND_LOOKBACK_MS))
      .order('created_at', { ascending: false })
      .limit(SCAN_LIMIT_PER_KIND),
    'inbound documents',
  )

  const fromDelivery = (kind: PeppolAlertKind, since: (row: DeliveryRow) => string) => (fetched: FetchedDeliveryRow): PeppolProblem => {
    const row = asDeliveryRow(fetched)
    return {
      kind,
      refId: row.id,
      companyId: row.company_id,
      since: since(row),
      detail: clip(row.status_detail),
      delivery: row,
    }
  }
  return [
    ...failed.map(fromDelivery('delivery_failed', (row) => row.terminal_at ?? row.status_at)),
    ...stuck.map(fromDelivery('delivery_stuck', (row) => row.status_at)),
    ...retryStuck.map(fromDelivery('delivery_retry_stuck', (row) => row.status_at)),
    ...inbound.map((row): PeppolProblem => ({
      kind: 'inbound_unrouted',
      refId: row.id,
      companyId: row.company_id,
      since: row.created_at,
      detail: clip(row.last_error),
      inbound: row,
    })),
  ]
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

/** Drop problems an earlier run already claimed, so the run's budget goes to new ones. */
async function unclaimed(service: SupabaseClient, problems: PeppolProblem[]): Promise<PeppolProblem[]> {
  const seen = new Set<string>()
  for (const kind of PEPPOL_ALERT_KINDS) {
    const refIds = problems.filter((problem) => problem.kind === kind).map((problem) => problem.refId)
    for (let i = 0; i < refIds.length; i += IN_CLAUSE_CHUNK) {
      const chunk = refIds.slice(i, i + IN_CLAUSE_CHUNK)
      const { data, error } = await service.from('peppol_alerts').select('ref_id').eq('kind', kind).in('ref_id', chunk)
      if (error) throw new Error(`Failed to read Peppol alert claims: ${error.message}`)
      for (const row of (data ?? []) as Array<{ ref_id: string }>) seen.add(problemKey(kind, row.ref_id))
    }
  }
  return problems.filter((problem) => !seen.has(problemKey(problem.kind, problem.refId)))
}

/** One statement: either every new problem is claimed or none is. */
async function claim(service: SupabaseClient, problems: PeppolProblem[]): Promise<PeppolProblem[]> {
  const rows = problems.map((problem) => ({
    kind: problem.kind,
    ref_id: problem.refId,
    company_id: problem.companyId,
  }))
  const { data, error } = await service
    .from('peppol_alerts')
    .upsert(rows, { onConflict: 'kind,ref_id', ignoreDuplicates: true })
    .select('kind, ref_id')
  if (error) throw new Error(`Failed to claim Peppol alerts: ${error.message}`)
  const claimed = new Set(((data ?? []) as Array<{ kind: string; ref_id: string }>).map((row) => problemKey(row.kind, row.ref_id)))
  return problems.filter((problem) => claimed.has(problemKey(problem.kind, problem.refId)))
}

/** Delete claims whose mail never went out, so the next run reports them again. */
async function release(service: SupabaseClient, problems: PeppolProblem[], log: Logger): Promise<number> {
  let released = 0
  for (const kind of PEPPOL_ALERT_KINDS) {
    const refIds = problems.filter((problem) => problem.kind === kind).map((problem) => problem.refId)
    for (let i = 0; i < refIds.length; i += IN_CLAUSE_CHUNK) {
      const chunk = refIds.slice(i, i + IN_CLAUSE_CHUNK)
      const { error } = await service.from('peppol_alerts').delete().eq('kind', kind).in('ref_id', chunk)
      if (error) {
        // The problem stays claimed and is not reported again: say which.
        log.error('peppol health: could not release claims, these problems will not be reported again', {
          alert: true,
          kind,
          refIds: chunk,
          reason: error.message,
        })
        continue
      }
      released += chunk.length
    }
  }
  return released
}

// ---------------------------------------------------------------------------
// Mails
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<PeppolAlertKind, string> = {
  delivery_failed: 'Leverans misslyckades',
  delivery_stuck: 'Leverans utan svar från operatören',
  delivery_retry_stuck: 'Tillfälligt fel som ingen skickat om',
  inbound_unrouted: 'Inkommande dokument har fastnat',
}

function formatAge(sinceIso: string, now: Date): string {
  const since = Date.parse(sinceIso)
  if (Number.isNaN(since)) return 'okänd ålder'
  const ms = Math.max(0, now.getTime() - since)
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`
  if (ms < 2 * DAY_MS) return `${Math.floor(ms / HOUR_MS)} tim`
  return `${Math.floor(ms / DAY_MS)} dagar`
}

async function loadCompanyNames(service: SupabaseClient, companyIds: string[], log: Logger): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  for (let i = 0; i < companyIds.length; i += IN_CLAUSE_CHUNK) {
    const { data, error } = await service
      .from('company_settings')
      .select('company_id, company_name')
      .in('company_id', companyIds.slice(i, i + IN_CLAUSE_CHUNK))
    if (error) {
      // Names are a courtesy: the digest still carries the company ids.
      log.warn('peppol health: company names unavailable for the digest', { reason: error.message })
      return names
    }
    for (const row of (data ?? []) as Array<{ company_id: string; company_name: string | null }>) {
      if (row.company_name) names.set(row.company_id, row.company_name)
    }
  }
  return names
}

function digestLine(problem: PeppolProblem, names: Map<string, string>, now: Date): string {
  const company = problem.companyId
    ? `${names.get(problem.companyId) ?? 'okänt bolag'} (${problem.companyId})`
    : 'inget bolag'
  const parts = [KIND_LABEL[problem.kind], company]
  if (problem.delivery) {
    parts.push(`faktura ${problem.delivery.invoice?.invoice_number ?? 'utan nummer'} (leverans ${problem.refId})`)
  }
  if (problem.inbound) {
    const recipient = problem.inbound.recipient_scheme && problem.inbound.recipient_identifier
      ? `${problem.inbound.recipient_scheme}:${problem.inbound.recipient_identifier}`
      : 'okänd'
    parts.push(
      `${problem.inbound.document_type} ${problem.inbound.provider_document_id} (dokument ${problem.refId}, ${problem.inbound.status}, mottagare ${recipient}, avsändare ${problem.inbound.sender_name ?? 'okänd'})`,
    )
  }
  parts.push(formatAge(problem.since, now), problem.detail ?? 'ingen orsak angiven')
  return parts.join(' | ')
}

async function sendDigest(
  email: EmailService,
  problems: PeppolProblem[],
  names: Map<string, string>,
  now: Date,
): Promise<{ ok: boolean; reason?: string }> {
  const lines = problems.map((problem) => digestLine(problem, names, now))
  const count = problems.length
  const subject = `[${getBranding().appName.toLowerCase()} peppol] ${count} ${count === 1 ? 'nytt Peppol-problem' : 'nya Peppol-problem'}`
  const intro = [
    `Peppol-hälsokontrollen hittade ${count} ${count === 1 ? 'nytt problem' : 'nya problem'}.`,
    ...(problems.some((problem) => problem.kind === 'delivery_failed')
      ? ['Avsändaren av en misslyckad faktura får ett eget mejl.']
      : []),
  ].join(' ')
  const text = [intro, '', ...lines.map((line) => `- ${line}`)].join('\n')
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    '<ul>',
    ...lines.map((line) => `<li>${escapeHtml(line)}</li>`),
    '</ul>',
  ].join('\n')
  try {
    const result = await email.sendEmail({ to: getSupportRecipientEmail(), subject, text, html })
    return result.success ? { ok: true } : { ok: false, reason: result.error ?? 'send failed' }
  } catch (err) {
    return { ok: false, reason: errorText(err) }
  }
}

type SenderMailOutcome = { outcome: 'sent' } | { outcome: 'no_recipient' } | { outcome: 'failed'; reason: string }

async function mailSender(
  email: EmailService,
  service: SupabaseClient,
  problem: PeppolProblem,
): Promise<SenderMailOutcome> {
  const delivery = problem.delivery
  if (!delivery) return { outcome: 'no_recipient' }
  const recipient = await resolveMemberEmail(service, delivery.company_id, delivery.user_id)
  if (!recipient) return { outcome: 'no_recipient' }

  // Brand mail (WL-13): the link and the sender follow the company's brand.
  const sender = await getSenderForCompany(delivery.company_id)
  const link = `${getBaseUrlForBrand(sender.brand)}/invoices/${delivery.invoice_id}`
  const number = delivery.invoice?.invoice_number ?? null
  const customer = delivery.invoice?.customer?.name?.trim() || null
  const reason = problem.detail ?? 'Operatören angav ingen orsak.'

  const subject = sanitizeSubjectLine(
    number ? `Faktura ${number} kunde inte levereras via Peppol` : 'En faktura kunde inte levereras via Peppol',
  )
  const opening = `Fakturan ${number ?? 'utan nummer'}${customer ? ` till ${customer}` : ''} kunde inte levereras via Peppol.`
  const action = 'Öppna fakturan och välj "Skicka via Peppol" igen när orsaken är åtgärdad, eller skicka PDF:en till kunden via e-post.'
  const text = [opening, '', `Orsak: ${reason}`, '', action, '', link].join('\n')
  const html = [
    `<p>${escapeHtml(opening)}</p>`,
    `<p>Orsak: ${escapeHtml(reason)}</p>`,
    `<p>${escapeHtml(action)}</p>`,
    `<p><a href="${escapeHtml(link)}">Öppna fakturan</a></p>`,
  ].join('')

  const result = await email.sendEmail({
    to: recipient,
    subject,
    text,
    html,
    ...(sender.fromName ? { fromName: sender.fromName } : {}),
    ...(sender.fromAddress ? { fromAddress: sender.fromAddress } : {}),
    ...(sender.replyTo ? { replyTo: sender.replyTo } : {}),
  })
  return result.success ? { outcome: 'sent' } : { outcome: 'failed', reason: result.error ?? 'send failed' }
}

// ---------------------------------------------------------------------------
// The check
// ---------------------------------------------------------------------------

/**
 * One pass over every company (service-role client). Throws only when the
 * rules or the claim cannot be read or written; mail failures are reported
 * in the summary and logged with alert: true.
 */
export async function runPeppolHealthCheck(
  service: SupabaseClient,
  options: { now?: Date; log?: Logger } = {},
): Promise<PeppolHealthSummary> {
  const now = options.now ?? new Date()
  const log = options.log ?? createLogger('peppol-health')
  const summary = emptySummary()

  const email = getEmailService()
  if (!email.isConfigured()) {
    log.info('peppol health check skipped: no e-mail service configured, nothing claimed')
    summary.skipped = 'email_not_configured'
    return summary
  }

  const problems = await findProblems(service, now)
  for (const problem of problems) summary.found[problem.kind] += 1
  if (problems.length === 0) return summary

  // The budget: the oldest new problems first, at most MAX_NEW_PER_RUN.
  const fresh = (await unclaimed(service, problems)).sort((a, b) => a.since.localeCompare(b.since))
  const batch = fresh.slice(0, MAX_NEW_PER_RUN)
  summary.deferred = fresh.length - batch.length
  if (batch.length === 0) return summary

  const claimed = await claim(service, batch)
  for (const problem of claimed) summary.claimed[problem.kind] += 1
  if (claimed.length === 0) return summary

  log.info('peppol health: new problems claimed', {
    problems: claimed.map((problem) => ({ kind: problem.kind, refId: problem.refId, companyId: problem.companyId })),
  })

  const companyIds = [...new Set(claimed.map((problem) => problem.companyId).filter((id): id is string => !!id))]
  const names = await loadCompanyNames(service, companyIds, log)
  const digest = await sendDigest(email, claimed, names, now)
  if (!digest.ok) {
    summary.digest = 'failed'
    summary.released += await release(service, claimed, log)
    log.error('peppol health: team digest failed, claims released for the next run', {
      alert: true,
      count: claimed.length,
      reason: digest.reason,
    })
    return summary
  }
  summary.digest = 'sent'

  for (const problem of claimed) {
    if (problem.kind !== 'delivery_failed') continue
    let mail: SenderMailOutcome
    try {
      mail = await mailSender(email, service, problem)
    } catch (err) {
      mail = { outcome: 'failed', reason: errorText(err) }
    }
    if (mail.outcome === 'sent') {
      summary.senderMails.sent += 1
    } else if (mail.outcome === 'no_recipient') {
      // Nobody to mail (the sender left the company or has no address); the
      // team digest already lists the failure, so the claim stays.
      summary.senderMails.noRecipient += 1
      log.info('peppol health: no member address for the sender of a failed delivery', {
        deliveryId: problem.refId,
        companyId: problem.companyId,
      })
    } else {
      summary.senderMails.failed += 1
      summary.released += await release(service, [problem], log)
      log.error('peppol health: sender mail failed, claim released for the next run', {
        alert: true,
        deliveryId: problem.refId,
        companyId: problem.companyId,
        reason: mail.reason,
      })
    }
  }
  return summary
}
