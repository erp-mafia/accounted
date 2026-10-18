/**
 * Peppol daily report: one morning e-mail to the operators with the last
 * 24 hours of Peppol traffic.
 *
 * Qvalia's production host has no delivery status yet (neither
 * `/invoices/outgoing/status` nor webhooks), so an accepted invoice never
 * learns whether it reached the buyer. Until it does, a person checks every
 * send in Qvalia's dashboard, and this report is the list to check against:
 * each send of the day with its Qvalia integration id, anything that failed,
 * each company's sends this month against its monthly cap, and new access
 * requests with whether the company pays.
 *
 * It goes out every day, an empty day included, so a missing report is itself
 * a signal. Recipients come from PEPPOL_DAILY_REPORT_RECIPIENTS (comma
 * separated); without it, or without an e-mail service, the report is skipped.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getBranding } from '@/lib/branding/service'
import { getEmailService } from '@/lib/email/service'
import { escapeHtml } from '@/lib/email/user-text'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { statusGrantsAccess } from '@/lib/stripe/subscription-sync'
import { formatCurrency } from '@/lib/utils'
import { peppolSendPeriodStart } from './peppol-access'

export const QVALIA_DASHBOARD_URL = 'https://app.qvalia.com/#/login'

const DAY_MS = 24 * 60 * 60 * 1000

const FAILED_STATUSES = ['failed', 'no_route', 'retryable_failure', 'business_rejected']

interface DeliveryRow {
  id: string
  company_id: string
  status: string
  status_at: string
  status_detail: string | null
  submitted_at: string | null
  provider_submission_id: string | null
  recipient_scheme: string
  recipient_identifier: string
  invoice: {
    invoice_number: string | null
    total: number | null
    currency: string | null
    customer: { name: string | null } | null
  } | null
}

export interface PeppolDailyReport {
  since: string
  until: string
  sends: DeliveryRow[]
  failures: DeliveryRow[]
  month: Array<{ companyId: string; sent: number; max: number | null }>
  newRequests: Array<{ companyId: string; requestedAt: string; paying: boolean }>
  openRequests: number
  inbound: number
  names: Map<string, string>
}

export type PeppolDailyReportResult =
  | { sent: true; sends: number; failures: number; recipients: number }
  | { sent: false; reason: 'no_recipients' | 'email_not_configured' | 'send_failed'; detail?: string }

export function getPeppolDailyReportRecipients(): string[] {
  return (process.env.PEPPOL_DAILY_REPORT_RECIPIENTS ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter((address) => address.includes('@'))
}

async function rows<T>(query: PromiseLike<{ data: unknown; error: { message: string } | null }>, label: string): Promise<T[]> {
  const { data, error } = await query
  if (error) throw new Error(`peppol daily report: ${label}: ${error.message}`)
  return (data ?? []) as T[]
}

/** Every page of a read ordered on its primary key, so paging never skips or repeats a row. */
async function allRows<T>(
  query: (range: { from: number; to: number }) => PromiseLike<{ data: unknown; error: { message: string } | null }>,
  label: string,
): Promise<T[]> {
  try {
    return await fetchAllRows<T>(query as (range: { from: number; to: number }) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>)
  } catch (err) {
    throw new Error(`peppol daily report: ${label}: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// The two delivery selects are spelled out rather than shared, so the schema
// guard (tests/schema/no-phantom-columns) can resolve their columns.
const byTime = (key: 'submitted_at' | 'status_at') => (a: DeliveryRow, b: DeliveryRow) => (a[key] ?? '').localeCompare(b[key] ?? '')

export async function buildPeppolDailyReport(service: SupabaseClient, now: Date = new Date()): Promise<PeppolDailyReport> {
  const until = now.toISOString()
  const since = new Date(now.getTime() - DAY_MS).toISOString()
  const monthStart = peppolSendPeriodStart(now)

  const sends = (await allRows<DeliveryRow>(({ from, to }) =>
    service
      .from('peppol_deliveries')
      .select('id, company_id, status, status_at, status_detail, submitted_at, provider_submission_id, recipient_scheme, recipient_identifier, invoice:invoices(invoice_number, total, currency, customer:customers(name))')
      .not('provider_submission_id', 'is', null)
      .gte('submitted_at', since)
      .order('id', { ascending: true })
      .range(from, to),
  'sends')).sort(byTime('submitted_at'))
  const failures = (await allRows<DeliveryRow>(({ from, to }) =>
    service
      .from('peppol_deliveries')
      .select('id, company_id, status, status_at, status_detail, submitted_at, provider_submission_id, recipient_scheme, recipient_identifier, invoice:invoices(invoice_number, total, currency, customer:customers(name))')
      .in('status', FAILED_STATUSES)
      .gte('status_at', since)
      .order('id', { ascending: true })
      .range(from, to),
  'failures')).sort(byTime('status_at'))
  // The same two halves countPeppolSends counts: stamped this month, or
  // never stamped and created this month.
  const monthSends = [
    ...await allRows<{ company_id: string }>(({ from, to }) =>
      service
        .from('peppol_deliveries')
        .select('id, company_id')
        .not('provider_submission_id', 'is', null)
        .gte('submitted_at', monthStart)
        .order('id', { ascending: true })
        .range(from, to),
    'month sends'),
    ...await allRows<{ company_id: string }>(({ from, to }) =>
      service
        .from('peppol_deliveries')
        .select('id, company_id')
        .not('provider_submission_id', 'is', null)
        .is('submitted_at', null)
        .gte('created_at', monthStart)
        .order('id', { ascending: true })
        .range(from, to),
    'month sends without a submission time'),
  ]
  const access = await allRows<{ company_id: string; status: string; max_sends: number | null; requested_at: string | null }>(({ from, to }) =>
    service
      .from('peppol_access')
      .select('company_id, status, max_sends, requested_at')
      .in('status', ['enabled', 'requested'])
      .order('company_id', { ascending: true })
      .range(from, to),
  'access')
  const { count: inbound, error: inboundError } = await service
    .from('peppol_inbound_documents')
    .select('id', { count: 'exact', head: true })
    .gte('created_at', since)
  if (inboundError) throw new Error(`peppol daily report: inbound: ${inboundError.message}`)

  const sentThisMonth = new Map<string, number>()
  for (const row of monthSends) sentThisMonth.set(row.company_id, (sentThisMonth.get(row.company_id) ?? 0) + 1)
  const month = access
    .filter((row) => row.status === 'enabled' && (sentThisMonth.get(row.company_id) ?? 0) > 0)
    .map((row) => ({ companyId: row.company_id, sent: sentThisMonth.get(row.company_id) ?? 0, max: row.max_sends }))
    .sort((a, b) => b.sent - a.sent)

  const requested = access.filter((row) => row.status === 'requested')
  const fresh = requested.filter((row) => row.requested_at !== null && row.requested_at >= since)
  const subscriptions = fresh.length === 0
    ? []
    : await rows<{ company_id: string; status: string | null }>(
      service.from('company_subscriptions').select('company_id, status').in('company_id', fresh.map((row) => row.company_id)),
      'subscriptions',
    )
  const subscriptionStatus = new Map(subscriptions.map((row) => [row.company_id, row.status]))
  const newRequests = fresh.map((row) => ({
    companyId: row.company_id,
    requestedAt: row.requested_at as string,
    paying: statusGrantsAccess(subscriptionStatus.get(row.company_id)),
  }))

  const companyIds = [...new Set([
    ...sends.map((row) => row.company_id),
    ...failures.map((row) => row.company_id),
    ...month.map((row) => row.companyId),
    ...newRequests.map((row) => row.companyId),
  ])]
  const names = new Map<string, string>()
  if (companyIds.length > 0) {
    const settings = await rows<{ company_id: string; company_name: string | null }>(
      service.from('company_settings').select('company_id, company_name').in('company_id', companyIds),
      'company names',
    )
    for (const row of settings) if (row.company_name) names.set(row.company_id, row.company_name)
  }

  return { since, until, sends, failures, month, newRequests, openRequests: requested.length, inbound: inbound ?? 0, names }
}

function stockholm(iso: string, options: Intl.DateTimeFormatOptions): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Stockholm', ...options }).format(new Date(iso))
}

function deliveryLine(row: DeliveryRow, names: Map<string, string>, at: string | null): string {
  const company = names.get(row.company_id) ?? row.company_id
  const invoice = row.invoice
  const buyer = invoice?.customer?.name ?? 'okänd köpare'
  const amount = invoice?.total !== null && invoice?.total !== undefined ? formatCurrency(Number(invoice.total), invoice.currency) : 'belopp saknas'
  const time = at ? stockholm(at, { hour: '2-digit', minute: '2-digit' }) : '--:--'
  return [
    `${time} ${company}`,
    `faktura ${invoice?.invoice_number ?? '?'} till ${buyer} (${row.recipient_scheme}:${row.recipient_identifier})`,
    amount,
    `Qvalia-id ${row.provider_submission_id ?? 'saknas'}`,
  ].join(', ')
}

export function renderPeppolDailyReport(report: PeppolDailyReport): { subject: string; text: string; html: string } {
  const day = stockholm(report.until, { day: 'numeric', month: 'short' })
  const { names } = report
  const subject = `[${getBranding().appName.toLowerCase()} peppol] Dagsrapport ${day}: ${report.sends.length} skickade, ${report.failures.length} fel`

  const sections: Array<{ heading: string; lines: string[]; empty: string }> = [
    {
      heading: `Skickade senaste dygnet (${report.sends.length})`,
      lines: report.sends.map((row) => deliveryLine(row, names, row.submitted_at)),
      empty: 'Inga Peppol-fakturor skickades.',
    },
    {
      heading: `Fel senaste dygnet (${report.failures.length})`,
      lines: report.failures.map((row) => `${deliveryLine(row, names, row.status_at)}, status ${row.status}${row.status_detail ? `: ${row.status_detail.slice(0, 200)}` : ''}`),
      empty: 'Inga fel.',
    },
    {
      heading: 'Skickade denna månad per bolag',
      lines: report.month.map((row) => `${names.get(row.companyId) ?? row.companyId}: ${row.sent} av ${row.max ?? 'obegränsat'}${row.max !== null && row.sent >= row.max ? ' (gränsen nådd)' : ''}`),
      empty: 'Inga sändningar denna månad.',
    },
    {
      heading: `Nya förfrågningar om Peppol (${report.newRequests.length}, totalt ${report.openRequests} öppna)`,
      lines: report.newRequests.map((row) => `${names.get(row.companyId) ?? row.companyId}: ${row.paying ? 'betalar eller har kort registrerat' : 'betalar inte'} (${row.companyId})`),
      empty: 'Inga nya förfrågningar.',
    },
  ]

  const intro = `Peppol senaste dygnet, ${stockholm(report.since, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} till ${stockholm(report.until, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}. Mottagna dokument: ${report.inbound}.`
  const reminder = `Qvalia rapporterar ännu inte leveransstatus till oss. Logga in på Qvalias dashboard och kontrollera att varje faktura ovan står som levererad: ${QVALIA_DASHBOARD_URL}`

  const text = [
    intro,
    '',
    ...sections.flatMap((section) => [section.heading, ...(section.lines.length ? section.lines.map((line) => `- ${line}`) : [section.empty]), '']),
    reminder,
  ].join('\n')
  const html = [
    `<p>${escapeHtml(intro)}</p>`,
    ...sections.flatMap((section) => [
      `<h3>${escapeHtml(section.heading)}</h3>`,
      section.lines.length
        ? `<ul>${section.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>`
        : `<p>${escapeHtml(section.empty)}</p>`,
    ]),
    `<p><strong>Qvalia rapporterar ännu inte leveransstatus till oss.</strong> Logga in på <a href="${QVALIA_DASHBOARD_URL}">Qvalias dashboard</a> och kontrollera att varje faktura ovan står som levererad.</p>`,
  ].join('\n')
  return { subject, text, html }
}

export async function sendPeppolDailyReport(service: SupabaseClient, now: Date = new Date()): Promise<PeppolDailyReportResult> {
  const recipients = getPeppolDailyReportRecipients()
  if (recipients.length === 0) return { sent: false, reason: 'no_recipients' }
  const email = await getEmailService()
  if (!email.isConfigured()) return { sent: false, reason: 'email_not_configured' }

  const report = await buildPeppolDailyReport(service, now)
  const { subject, text, html } = renderPeppolDailyReport(report)
  const result = await email.sendEmail({ to: recipients, subject, text, html })
  if (!result.success) return { sent: false, reason: 'send_failed', detail: result.error }
  return { sent: true, sends: report.sends.length, failures: report.failures.length, recipients: recipients.length }
}
