import type { SupabaseClient } from '@supabase/supabase-js'
import { todayIsoStockholm, stockholmYearMonth } from '@/lib/dates/iso'
import { HAS_ISSUE_STEP_OR_ARMS } from '@/lib/bookkeeping/credit-note-state'
import { effectiveQuoteStatus, quoteHasLiveFollowUp } from '@/lib/invoices/quote-status'

/**
 * Resume list ("Fortsätt") for the homepage: in-progress work derived purely
 * from draft/mid-lifecycle state.
 * No event log, no presence table: a completed flow can never render here
 * because only draft-state rows are ever fetched (the reliability invariant).
 *
 * Lives in lib/worklist (owns pending-work predicates) but is deliberately
 * NOT part of WorklistCounts.total: Att göra = obligations the system
 * imposes; Fortsätt = work the user started and left. An item renders in
 * exactly one surface.
 */

export type ResumeItemKind =
  | 'journal_draft'
  | 'invoice_draft'
  | 'invoice_unsent'
  | 'quote_unsent'
  | 'quote_to_invoice'
  | 'salary_run'

export type ResumeSalaryStatus = 'draft' | 'review' | 'approved' | 'paid'

export interface ResumeItem {
  kind: ResumeItemKind
  /** Stable reference, e.g. 'invoice:<uuid>'. */
  ref: string
  href: string
  /** Free-text context: verifikat description, customer name, or period. */
  context: string | null
  /** Document number (unsent invoices, quotes). */
  number?: string | null
  amount?: number | null
  currency?: string | null
  salaryStatus?: ResumeSalaryStatus
  /** Deadline boost: work whose own date has passed (an unsent invoice past
   *  its invoice date, a stale salary run) outranks newer trivial drafts
   *  (Iqbal & Horvitz: deadline-tied tasks matter more). Only a date sets
   *  it: having a number is not a deadline. */
  late?: boolean
  updated_at: string
}

export const RESUME_MAX_ROWS = 3

/** A salary run whose period lies >= this many months back is "late". */
const SALARY_LATE_MONTHS = 2

/**
 * How many open/accepted quotes one read scans. Accepted quotes that were
 * already invoiced are dropped after the read, so the window is wider than
 * the pane; an untouched accepted quote behind this many newer ones is
 * outranked anyway.
 */
export const RESUME_QUOTE_SCAN = 20

export function isSalaryRunLate(
  periodYear: number,
  periodMonth: number,
  now: Date,
): boolean {
  const { year, month } = stockholmYearMonth(now)
  const monthsBehind = (year - periodYear) * 12 + (month - periodMonth)
  return monthsBehind >= SALARY_LATE_MONTHS
}

type CustomerEmbed = { name: string } | { name: string }[] | null

function customerName(customer: CustomerEmbed | undefined): string | null {
  const row = Array.isArray(customer) ? customer[0] : customer
  return row?.name ?? null
}

/** A draft faktura row (document_type 'invoice', status 'draft'). */
export interface ResumeInvoiceRow {
  id: string
  invoice_number: string | null
  invoice_date: string | null
  total: number | null
  currency: string | null
  updated_at: string
  customer?: CustomerEmbed
}

/**
 * A draft faktura: still being written, or numbered through Granska & skapa
 * and waiting to be sent. A numbered one is late only once its invoice date
 * has passed: a faktura dated today or later is on time.
 */
export function invoiceResumeItem(row: ResumeInvoiceRow, today: string): ResumeItem {
  const unsent = !!row.invoice_number
  return {
    kind: unsent ? 'invoice_unsent' : 'invoice_draft',
    ref: `invoice:${row.id}`,
    href: `/invoices/${row.id}`,
    context: customerName(row.customer),
    number: row.invoice_number,
    amount: row.total,
    currency: row.currency,
    late: unsent && !!row.invoice_date && row.invoice_date < today,
    updated_at: row.updated_at,
  }
}

/** A quote row (document_type 'quote') with the follow-ups made from it. */
export interface ResumeQuoteRow {
  id: string
  invoice_number: string | null
  status: string
  quote_status: string | null
  valid_until: string | null
  total: number | null
  currency: string | null
  updated_at: string
  /** Net of the quote: a part invoice (crm#1196) leaves the rest to invoice. */
  subtotal?: number | string | null
  customer?: CustomerEmbed
  conversions?: Array<{ status: string; subtotal?: number | string | null }> | null
  orders?: Array<{ status: string }> | null
}

/**
 * The next step on a quote, or null when there is none:
 *   - open, never sent: send it ("Skicka offert");
 *   - accepted, not fully invoiced and not ordered: create the invoice
 *     ("Skapa faktura"), whether or not the quote itself was ever sent, and
 *     also after a part invoice (crm#1196) until the rest is invoiced;
 *   - open and sent: the customer decides, nothing for the user to do;
 *   - expired, declined, cancelled or already invoiced: no work.
 * A quote is never late here: its dates are the offertdatum and the expiry,
 * and neither is a deadline for the user (an expired quote leaves the list).
 */
export function quoteResumeItem(row: ResumeQuoteRow, today: string): ResumeItem | null {
  if (row.status === 'cancelled') return null
  const decision = effectiveQuoteStatus(row, today)
  let kind: ResumeItemKind
  if (decision === 'open' && row.status === 'draft') {
    kind = 'quote_unsent'
  } else if (decision === 'accepted' && !quoteHasLiveFollowUp(row)) {
    kind = 'quote_to_invoice'
  } else {
    return null
  }
  return {
    kind,
    ref: `invoice:${row.id}`,
    href: `/invoices/${row.id}`,
    context: customerName(row.customer),
    number: row.invoice_number,
    amount: row.total,
    currency: row.currency,
    late: false,
    updated_at: row.updated_at,
  }
}

/**
 * Pure ordering + cap: late items first (deadline boost), then most recently
 * touched. Deterministic and explainable: no scoring, no ML.
 */
export function mergeResumeItems(items: ResumeItem[]): ResumeItem[] {
  return [...items]
    .sort((a, b) => {
      if (Boolean(a.late) !== Boolean(b.late)) return a.late ? -1 : 1
      return b.updated_at.localeCompare(a.updated_at)
    })
    .slice(0, RESUME_MAX_ROWS)
}

/**
 * Fetch resume candidates for a company. Every query soft-fails to empty:
 * the worst case is a missing pane, never a broken homepage.
 */
export async function listResumeItems(
  supabase: SupabaseClient,
  companyId: string,
  now: Date = new Date(),
): Promise<ResumeItem[]> {
  const today = todayIsoStockholm(now)
  const [journalRes, invoiceRes, quoteRes, salaryRes] = await Promise.all([
    supabase
      .from('journal_entries')
      .select('id, description, updated_at')
      .eq('company_id', companyId)
      .eq('status', 'draft')
      .order('updated_at', { ascending: false })
      .limit(RESUME_MAX_ROWS + 1)
      .then((r) => r, () => ({ data: null })),
    // Fakturor only: quotes, proformas and delivery notes carry a number from
    // insert, so "numbered draft" means "finalized, unsent" only for these.
    supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, total, currency, updated_at, customer:customers(name)')
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .eq('status', 'draft')
      .or(HAS_ISSUE_STEP_OR_ARMS)
      .order('updated_at', { ascending: false })
      .limit(RESUME_MAX_ROWS + 1)
      .then((r) => r, () => ({ data: null })),
    // Quotes with a next step: a draft (open or accepted) or a sent quote the
    // customer accepted. quoteResumeItem decides; the filter only narrows.
    supabase
      .from('invoices')
      .select(
        'id, invoice_number, status, quote_status, valid_until, subtotal, total, currency, updated_at, customer:customers(name), conversions:invoices!converted_from_id(status, subtotal), orders:sales_orders!source_invoice_id(status)',
      )
      .eq('company_id', companyId)
      .eq('document_type', 'quote')
      .in('status', ['draft', 'sent'])
      .in('quote_status', ['open', 'accepted'])
      .or('status.eq.draft,quote_status.eq.accepted')
      .order('updated_at', { ascending: false })
      .limit(RESUME_QUOTE_SCAN)
      .then((r) => r, () => ({ data: null })),
    supabase
      .from('salary_runs')
      .select('id, period_year, period_month, status, updated_at')
      .eq('company_id', companyId)
      // Enumerated on purpose: `!= 'booked'` would resurface 'corrected'.
      .in('status', ['draft', 'review', 'approved', 'paid'])
      .order('updated_at', { ascending: false })
      .limit(RESUME_MAX_ROWS + 1)
      .then((r) => r, () => ({ data: null })),
  ])

  const items: ResumeItem[] = []

  for (const row of (journalRes.data ?? []) as Array<{
    id: string
    description: string | null
    updated_at: string
  }>) {
    items.push({
      kind: 'journal_draft',
      ref: `journal:${row.id}`,
      href: `/bookkeeping/${row.id}`,
      context: row.description,
      updated_at: row.updated_at,
    })
  }

  for (const row of (invoiceRes.data ?? []) as ResumeInvoiceRow[]) {
    items.push(invoiceResumeItem(row, today))
  }

  for (const row of (quoteRes.data ?? []) as ResumeQuoteRow[]) {
    const item = quoteResumeItem(row, today)
    if (item) items.push(item)
  }

  for (const row of (salaryRes.data ?? []) as Array<{
    id: string
    period_year: number
    period_month: number
    status: ResumeSalaryStatus
    updated_at: string
  }>) {
    items.push({
      kind: 'salary_run',
      ref: `salary:${row.id}`,
      href: `/salary/runs/${row.id}`,
      context: `${row.period_year}-${String(row.period_month).padStart(2, '0')}`,
      salaryStatus: row.status,
      late: isSalaryRunLate(row.period_year, row.period_month, now),
      updated_at: row.updated_at,
    })
  }

  return mergeResumeItems(items)
}
