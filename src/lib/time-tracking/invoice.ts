/**
 * A draft invoice from a customer's uninvoiced billable hours.
 *
 * The invoice is built and written by the one staged create_invoice path
 * (buildStagedInvoice for the preview, createInvoiceFromStagedParams for the
 * write), so VAT rules, payee, numbering and invoice.created are exactly what
 * gnubok_create_invoice does. This module only turns hours into lines and,
 * once the draft exists, links the entries to it (time_entries.invoice_id),
 * which freezes them. Deleting the draft unlinks them again (ON DELETE SET
 * NULL), so nothing here is a dead end.
 */
import type { OperationOutcome } from '@/lib/operations/types'
import { buildStagedInvoice, describeInvoiceBuildRefusal } from '@/lib/pending-operations/build-staged-invoice'
import { createInvoiceFromStagedParams } from '@/lib/pending-operations/create-invoice-commit'
import type { InvoiceBuilderCustomer } from '@/lib/invoices/build-invoice-write'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { fetchAllTimeEntries, loadTimeTrackingSettings, withCustomerName } from './service'
import type { TimeEntryRow } from './service'
import { resolveHourlyRate } from './summary'
import { isInvoiced } from './types'
import type { TimeEntry, TimeTrackingSettings } from './types'
import type { TimeWriteContext } from './writes'

export const TIME_INVOICE_MAX_ENTRIES = 2000
const DEFAULT_PAYMENT_TERMS_DAYS = 30

export type TimeInvoiceLines = 'activity' | 'entry'

export interface TimeInvoiceInput {
  customer_id: string
  from?: string
  to?: string
  invoice_date: string
  due_date?: string
  /** activity: one line per activity code, rate and project; entry: one line per time entry. */
  lines: TimeInvoiceLines
  our_reference?: string | null
  your_reference?: string | null
  /** Pinned at staging: exactly these entries, and the totals the approver saw. */
  time_entry_ids?: string[]
  expected_hours?: number
  expected_subtotal?: number
}

interface InvoiceLine {
  description: string
  quantity: number
  unit: string
  unit_price: number
  dimensions?: Record<string, string>
}

const round2 = (x: number) => Math.round(x * 100) / 100

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

const activityName = (settings: TimeTrackingSettings, code: string | null) =>
  (code ? settings.activity_codes.find((a) => a.code === code)?.name : null) ?? 'Arbetad tid'

/** Lines from priced entries, in a stable order so the preview and the commit agree. */
export function buildTimeInvoiceLines(
  entries: TimeEntry[],
  settings: TimeTrackingSettings,
  lines: TimeInvoiceLines,
): InvoiceLine[] {
  const priced = entries.map((e) => ({ e, rate: resolveHourlyRate(e.activity_code, settings) as number }))
  const dims = (project: string | null) => (project ? { dimensions: { '6': project } } : {})

  if (lines === 'entry') {
    return priced
      .slice()
      .sort((a, b) => a.e.entry_date.localeCompare(b.e.entry_date) || a.e.id.localeCompare(b.e.id))
      .map(({ e, rate }) => ({
        description: `${e.entry_date} ${e.consultant}: ${e.comment?.trim() || activityName(settings, e.activity_code)}`,
        quantity: Number(e.hours),
        unit: 'tim',
        unit_price: rate,
        ...dims(e.project_code),
      }))
  }

  const groups = new Map<string, { activity: string | null; project: string | null; rate: number; hours: number; first: string; last: string }>()
  for (const { e, rate } of priced) {
    const key = `${e.activity_code ?? ''}|${e.project_code ?? ''}|${rate}`
    const g = groups.get(key)
    if (!g) {
      groups.set(key, { activity: e.activity_code, project: e.project_code, rate, hours: Number(e.hours), first: e.entry_date, last: e.entry_date })
      continue
    }
    g.hours += Number(e.hours)
    if (e.entry_date < g.first) g.first = e.entry_date
    if (e.entry_date > g.last) g.last = e.entry_date
  }
  return [...groups.values()]
    .map((g) => {
      const period = g.first === g.last ? g.first : `${g.first} till ${g.last}`
      const project = g.project ? `, projekt ${g.project}` : ''
      return {
        description: `${activityName(settings, g.activity)}${project}, ${period}`,
        quantity: round2(g.hours),
        unit: 'tim',
        unit_price: g.rate,
        ...dims(g.project),
      }
    })
    .sort((a, b) => a.description.localeCompare(b.description, 'sv'))
}

async function loadPinnedEntries(ctx: TimeWriteContext, ids: string[]): Promise<TimeEntry[]> {
  const rows = await fetchAllRows<TimeEntryRow>(({ from, to }) =>
    ctx.supabase
      .from('time_entries')
      .select('id, company_id, user_id, entry_date, consultant, customer_id, customer_code, customer_name, project_code, activity_code, hours, comment, is_billable, invoice_id, invoiced_externally, source, import_key, created_at, updated_at, customers(name)')
      .eq('company_id', ctx.companyId)
      .in('id', ids)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: TimeEntryRow[] | null; error: { message: string } | null }>,
  )
  return rows.map(withCustomerName)
}

async function dueDateFor(ctx: TimeWriteContext, customer: { default_payment_terms?: number | null }, invoiceDate: string) {
  // 0 days is a real term (due on receipt); only a missing value falls through.
  let terms = customer.default_payment_terms ?? null
  if (terms == null) {
    const { data, error } = await ctx.supabase
      .from('company_settings')
      .select('invoice_default_days')
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (error) throw error
    terms = (data as { invoice_default_days?: number | null } | null)?.invoice_default_days ?? null
  }
  return addDays(invoiceDate, terms ?? DEFAULT_PAYMENT_TERMS_DAYS)
}

export interface TimeInvoicePreview {
  customer_id: string
  customer_name: string
  invoice_date: string
  due_date: string
  lines: Array<{ description: string; hours: number; hourly_rate: number; amount: number }>
  hours: number
  subtotal: number
  vat_amount: number
  total: number
  entry_count: number
  time_entry_ids: string[]
  vat_warnings?: unknown[]
  will: string
  [key: string]: unknown
}

export interface TimeInvoiceResult {
  invoice_id: string
  entry_count: number
  hours: number
  subtotal: number
}

/** Stage-able: a dry run previews the draft; the write creates it and links the entries. */
export async function invoiceTimeEntries(
  ctx: TimeWriteContext,
  input: TimeInvoiceInput,
  options: { dryRun: boolean },
): Promise<OperationOutcome<TimeInvoiceResult>> {
  try {
    const { data: customer, error: customerError } = await ctx.supabase
      .from('customers')
      .select('*')
      .eq('id', input.customer_id)
      .eq('company_id', ctx.companyId)
      .maybeSingle()
    if (customerError) throw customerError
    if (!customer) return { ok: false, code: 'TIME_ENTRY_CUSTOMER_NOT_FOUND', details: { customer_id: input.customer_id } }

    const pinned = input.time_entry_ids
    const entries = pinned
      ? await loadPinnedEntries(ctx, pinned)
      : await fetchAllTimeEntries(ctx, { customer_id: input.customer_id, from: input.from, to: input.to, uninvoiced: true })

    if (pinned) {
      // The approver saw these rows: every one must still be here, billable,
      // uninvoiced and on this customer, or the draft would bill something else.
      const usable = entries.filter((e) => e.customer_id === input.customer_id && e.is_billable && !isInvoiced(e))
      if (usable.length !== pinned.length) {
        return { ok: false, code: 'TIME_INVOICE_ENTRIES_CHANGED', details: { expected: pinned.length, usable: usable.length } }
      }
    }
    if (entries.length === 0) {
      return { ok: false, code: 'TIME_INVOICE_NOTHING_TO_INVOICE', details: { customer_id: input.customer_id, from: input.from ?? null, to: input.to ?? null } }
    }
    if (entries.length > TIME_INVOICE_MAX_ENTRIES) {
      return { ok: false, code: 'TIME_INVOICE_TOO_MANY_ENTRIES', details: { entries: entries.length, max: TIME_INVOICE_MAX_ENTRIES } }
    }

    const settings = await loadTimeTrackingSettings(ctx)
    const unpriced = entries.filter((e) => resolveHourlyRate(e.activity_code, settings) === null)
    if (unpriced.length > 0) {
      return {
        ok: false,
        code: 'TIME_INVOICE_RATE_MISSING',
        details: {
          entries: unpriced.length,
          activity_codes: [...new Set(unpriced.map((e) => e.activity_code ?? null))],
        },
      }
    }

    const lines = buildTimeInvoiceLines(entries, settings, input.lines)
    const hours = round2(entries.reduce((s, e) => s + Number(e.hours), 0))
    const dueDate = input.due_date ?? (await dueDateFor(ctx, customer, input.invoice_date))
    const params: Record<string, unknown> = {
      customer_id: input.customer_id,
      invoice_date: input.invoice_date,
      due_date: dueDate,
      items: lines.map((l) => ({ line_type: 'product', ...l })),
      our_reference: input.our_reference ?? null,
      your_reference: input.your_reference ?? null,
    }

    const staged = await buildStagedInvoice({ supabase: ctx.supabase, companyId: ctx.companyId, customer: customer as InvoiceBuilderCustomer, params })
    if (!staged.ok) {
      if ('validation' in staged) {
        const issue = staged.validation.issues[0]
        return { ok: false, code: 'VALIDATION_ERROR', details: { field: issue?.path?.join('.') ?? 'items', message: issue?.message } }
      }
      if ('dbError' in staged) throw staged.dbError
      return { ok: false, code: staged.code, details: { ...(staged.details ?? {}), reason: describeInvoiceBuildRefusal(staged.code, staged.details) } }
    }
    const subtotal = round2(Number(staged.build.invoiceFields.subtotal))

    if (input.expected_hours !== undefined && (input.expected_hours !== hours || input.expected_subtotal !== subtotal)) {
      return {
        ok: false,
        code: 'TIME_INVOICE_ENTRIES_CHANGED',
        details: { expected_hours: input.expected_hours, hours, expected_subtotal: input.expected_subtotal ?? null, subtotal },
      }
    }

    const ids = entries.map((e) => e.id).sort()
    if (options.dryRun) {
      const preview: TimeInvoicePreview = {
        customer_id: input.customer_id,
        customer_name: String((customer as { name: string }).name),
        invoice_date: input.invoice_date,
        due_date: dueDate,
        lines: lines.map((l) => ({ description: l.description, hours: l.quantity, hourly_rate: l.unit_price, amount: round2(l.quantity * l.unit_price) })),
        hours,
        subtotal,
        vat_amount: round2(Number(staged.build.invoiceFields.vat_amount)),
        total: round2(Number(staged.build.invoiceFields.total)),
        entry_count: ids.length,
        time_entry_ids: ids,
        ...(staged.build.warnings.length > 0 ? { vat_warnings: staged.build.warnings } : {}),
        will: 'create a draft invoice (not sent, not booked) and link the hours to it; deleting the draft frees them again',
      }
      return { ok: true, dryRun: true, preview }
    }

    const created = await createInvoiceFromStagedParams(ctx.supabase, ctx.userId, ctx.companyId, params)
    if (created.error || !created.data) {
      return {
        ok: false,
        code: created.errorCode ?? 'UNKNOWN_ERROR',
        messageSv: created.error,
        details: created.data,
      }
    }
    const invoiceId = String(created.data.invoice_id)

    // Link only rows still uninvoiced: one invoiced elsewhere since the read stays where it is.
    const { data: linked, error: linkError } = await ctx.supabase
      .from('time_entries')
      .update({ invoice_id: invoiceId })
      .eq('company_id', ctx.companyId)
      .in('id', ids)
      .is('invoice_id', null)
      .eq('invoiced_externally', false)
      .select('id')
    if (linkError || (linked ?? []).length !== ids.length) {
      ctx.log.error('time_entries invoice link incomplete', linkError ?? { linked: linked?.length, expected: ids.length })
      return {
        ok: false,
        code: 'TIME_INVOICE_ENTRIES_CHANGED',
        details: { invoice_id: invoiceId, linked: linked?.length ?? 0, expected: ids.length },
        // The draft exists: the approval lands as failed_partial and names it.
        partialPostedIds: { invoice_id: invoiceId },
      }
    }
    return { ok: true, data: { invoice_id: invoiceId, entry_count: ids.length, hours, subtotal }, created: true }
  } catch (error) {
    ctx.log.error('time invoice failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
}
