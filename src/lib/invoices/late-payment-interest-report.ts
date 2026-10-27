import type { SupabaseClient } from '@supabase/supabase-js'
import { dbError } from '@/lib/errors/db-error'
import { invoiceDisplayNumber } from '@/lib/invoices/display'
import { calculateLatePaymentInterest, getAnnualInterestRate } from '@/lib/invoices/late-payment-interest'
import { roundOre } from '@/lib/money'
import { fetchAllRows } from '@/lib/supabase/fetch-all'

/**
 * Dröjsmålsränta per customer invoice (accounted#38): what each invoice
 * that was paid late earned in interest, and what each overdue unpaid
 * invoice has accrued so far. Read only; it books and sends nothing.
 *
 * Paid late counts only payments recorded in Accounted: an invoice_payments
 * row whose verifikat was booked here as a payment (PAYMENT_SOURCE_TYPES).
 * Imported history is left out on purpose (founder call 2026-10-26): a paid
 * date that came with an import, a payment row linked to an imported
 * verifikat, or a registered partial payment without one says when the old
 * system recorded the payment, which is not a date anyone should charge
 * interest on. Settlements that move no money (kreditfaktura, kundförlust)
 * and payments a collections provider collected (it charges its own
 * interest) are left out too.
 *
 * Each late payment earns interest on its own amount from the due date to
 * its payment date, so a partly late invoice is charged only for the part
 * that was late. An open invoice accrues on its remaining amount up to the
 * as-of date. Amounts stay in the invoice's currency.
 */

/** journal_entries.source_type of a verifikat that records a customer payment made in Accounted. */
export const PAYMENT_SOURCE_TYPES: ReadonlySet<string> = new Set([
  'invoice_paid',
  'invoice_cash_payment',
  'bank_transaction',
  'manual',
  'correction',
  'counterparty_setoff',
])

const OPEN_STATUSES = ['sent', 'overdue', 'partially_paid'] as const

export interface LatePaidInvoice {
  invoice_id: string
  invoice_number: string
  customer_name: string | null
  currency: string
  due_date: string
  /** Sum of the payments that arrived after the due date. */
  paid_late_amount: number
  /** Date of the last late payment. */
  last_payment_date: string
  /** Days late of the latest late payment. */
  days_late: number
  interest: number
}

export interface OverdueOpenInvoice {
  invoice_id: string
  invoice_number: string
  customer_name: string | null
  currency: string
  due_date: string
  remaining_amount: number
  days_overdue: number
  /** Interest accrued from the due date up to the as-of date. */
  interest: number
}

export interface LatePaymentInterestTotal {
  currency: string
  paid_late_interest: number
  overdue_interest: number
}

export interface LatePaymentInterestReport {
  as_of: string
  /** The yearly rate in effect on as_of (decimal fraction). */
  rate: number
  /** True when the company's own rate replaces the statutory one. */
  rate_is_override: boolean
  paid_late: LatePaidInvoice[]
  overdue_open: OverdueOpenInvoice[]
  totals: LatePaymentInterestTotal[]
}

interface InvoiceRow {
  id: string
  invoice_number: string | null
  external_invoice_number: string | null
  due_date: string
  currency: string
  status: string
  document_type: string
  credited_invoice_id: string | null
  remaining_amount?: number | string | null
  customer: { name: string | null } | null
}

interface PaymentRow {
  id: string
  invoice_id: string
  payment_date: string
  amount: number | string
  journal_entry: { source_type: string | null } | null
  invoice: InvoiceRow | null
}

function isChargeableInvoice(invoice: InvoiceRow | null): invoice is InvoiceRow {
  return !!invoice && invoice.document_type === 'invoice' && !invoice.credited_invoice_id
}

export async function getLatePaymentInterestReport(
  supabase: SupabaseClient,
  companyId: string,
  asOf: string,
): Promise<LatePaymentInterestReport> {
  const { data: settings, error: settingsError } = await supabase
    .from('company_settings')
    .select('reminder_interest_rate_override')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsError) throw dbError(settingsError)
  const rawOverride = (settings as { reminder_interest_rate_override: number | string | null } | null)
    ?.reminder_interest_rate_override
  const overrideRate = rawOverride === null || rawOverride === undefined ? null : Number(rawOverride)

  const payments = await fetchAllRows<PaymentRow>(({ from, to }) =>
    supabase
      .from('invoice_payments')
      .select(
        'id, invoice_id, payment_date, amount, journal_entry:journal_entries!journal_entry_id(source_type), invoice:invoices!inner(id, invoice_number, external_invoice_number, due_date, currency, status, document_type, credited_invoice_id, customer:customers(name))',
      )
      .eq('company_id', companyId)
      .not('journal_entry_id', 'is', null)
      .lte('payment_date', asOf)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: PaymentRow[] | null; error: { message: string } | null }>,
  )

  const openInvoices = await fetchAllRows<InvoiceRow>(({ from, to }) =>
    supabase
      .from('invoices')
      .select(
        'id, invoice_number, external_invoice_number, due_date, currency, status, document_type, credited_invoice_id, remaining_amount, customer:customers(name)',
      )
      .eq('company_id', companyId)
      .eq('document_type', 'invoice')
      .in('status', [...OPEN_STATUSES])
      .lt('due_date', asOf)
      .gt('remaining_amount', 0)
      .order('id', { ascending: true })
      .range(from, to) as unknown as PromiseLike<{ data: InvoiceRow[] | null; error: { message: string } | null }>,
  )

  const paidLate = new Map<string, LatePaidInvoice>()
  for (const payment of payments) {
    const invoice = payment.invoice
    if (!isChargeableInvoice(invoice)) continue
    if (!PAYMENT_SOURCE_TYPES.has(payment.journal_entry?.source_type ?? '')) continue
    const amount = Number(payment.amount)
    if (!(amount > 0) || payment.payment_date <= invoice.due_date) continue

    const { amount: interest, days } = calculateLatePaymentInterest({
      overdueAmount: amount,
      dueDate: invoice.due_date,
      asOfDate: payment.payment_date,
      overrideRate,
    })
    const row = paidLate.get(invoice.id) ?? {
      invoice_id: invoice.id,
      invoice_number: invoiceDisplayNumber(invoice),
      customer_name: invoice.customer?.name ?? null,
      currency: invoice.currency,
      due_date: invoice.due_date,
      paid_late_amount: 0,
      last_payment_date: payment.payment_date,
      days_late: days,
      interest: 0,
    }
    row.paid_late_amount = roundOre(row.paid_late_amount + amount)
    row.interest = roundOre(row.interest + interest)
    if (payment.payment_date >= row.last_payment_date) {
      row.last_payment_date = payment.payment_date
      row.days_late = days
    }
    paidLate.set(invoice.id, row)
  }

  const overdueOpen: OverdueOpenInvoice[] = []
  for (const invoice of openInvoices) {
    if (!isChargeableInvoice(invoice)) continue
    const remaining = Number(invoice.remaining_amount ?? 0)
    if (!(remaining > 0)) continue
    const { amount: interest, days } = calculateLatePaymentInterest({
      overdueAmount: remaining,
      dueDate: invoice.due_date,
      asOfDate: asOf,
      overrideRate,
    })
    overdueOpen.push({
      invoice_id: invoice.id,
      invoice_number: invoiceDisplayNumber(invoice),
      customer_name: invoice.customer?.name ?? null,
      currency: invoice.currency,
      due_date: invoice.due_date,
      remaining_amount: remaining,
      days_overdue: days,
      interest,
    })
  }

  const paidLateRows = [...paidLate.values()]
    .filter((row) => row.interest > 0)
    .sort((a, b) => b.last_payment_date.localeCompare(a.last_payment_date) || a.invoice_number.localeCompare(b.invoice_number))
  overdueOpen.sort((a, b) => a.due_date.localeCompare(b.due_date) || a.invoice_number.localeCompare(b.invoice_number))

  return {
    as_of: asOf,
    rate: getAnnualInterestRate(asOf, overrideRate),
    rate_is_override: overrideRate !== null,
    paid_late: paidLateRows,
    overdue_open: overdueOpen,
    totals: totalsByCurrency(paidLateRows, overdueOpen),
  }
}

function totalsByCurrency(paidLate: LatePaidInvoice[], overdueOpen: OverdueOpenInvoice[]): LatePaymentInterestTotal[] {
  const totals = new Map<string, LatePaymentInterestTotal>()
  const entry = (currency: string) => {
    const existing = totals.get(currency) ?? { currency, paid_late_interest: 0, overdue_interest: 0 }
    totals.set(currency, existing)
    return existing
  }
  for (const row of paidLate) {
    const total = entry(row.currency)
    total.paid_late_interest = roundOre(total.paid_late_interest + row.interest)
  }
  for (const row of overdueOpen) {
    const total = entry(row.currency)
    total.overdue_interest = roundOre(total.overdue_interest + row.interest)
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency))
}
