import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { roundOre } from '@/lib/money'
import { fetchPaymentsAsOf, outstandingAsOf, todayIsoDate, type PaymentsAsOf } from './reskontra-payments'

export interface ARInvoiceDetail {
  invoice_id: string
  invoice_number: string
  invoice_date: string
  due_date: string
  total: number
  paid_amount: number
  /** Outstanding in the invoice's original currency. Use for display only. */
  outstanding: number
  /**
   * Outstanding converted to SEK using the invoice-date exchange_rate. `null`
   * when conversion failed (FX invoice with no rate). Callers summing across
   * customers must use this field, never `outstanding`, to avoid mixing
   * currencies.
   */
  outstanding_sek: number | null
  days_overdue: number
  currency: string
}

export interface ARLedgerEntry {
  customer_id: string
  customer_name: string
  invoices: ARInvoiceDetail[]
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
  total_outstanding: number
}

export interface ARLedgerReport {
  entries: ARLedgerEntry[]
  total_outstanding: number
  total_current: number
  total_overdue: number
  unpaid_count: number
  /**
   * Number of foreign-currency invoices excluded from the SEK totals because
   * they had no exchange_rate. Their detail rows are still listed (with
   * outstanding_sek = null) so the user can see them.
   */
  unconverted_fx_count: number
}

/**
 * Generate AR ledger (kundreskontra) with aging analysis.
 * BFL 5 kap. 4 §: sidoordnad bokföring: outstanding customer invoices with aging.
 *
 * With a backdated `asOfDate` the ledger is reconstructed as it stood on that
 * date: invoices dated on or before it (including ones fully paid since) with
 * outstanding amounts recomputed from the payment history (#1020). Without an
 * `asOfDate`, or with today/future, the live open-invoice state is used as-is.
 */
export async function generateARLedger(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string
): Promise<ARLedgerReport> {
  const refDate = asOfDate ? new Date(asOfDate) : new Date()
  // Backdated reconstruction only kicks in for genuinely historical dates:
  // for today/future the stored open-invoice state IS the as-of state, and
  // the live view must stay byte-identical to what it always showed.
  const isHistorical = !!asOfDate && asOfDate < todayIsoDate()

  // Fetch the ledger population. Live view: open invoices only. Historical
  // view: also invoices paid since the as-of date, restricted to invoice
  // dates on or before it. Invoices cancelled since are treated as never
  // having existed (their cancellation is not reliably dated).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoices: any[]
  let payments: PaymentsAsOf | null = null
  try {
    invoices = await fetchAllRows(({ from, to }) => {
      let query = supabase
        .from('invoices')
        .select('*, customer:customers(id, name)')
        .eq('company_id', companyId)
        // Proformas, delivery notes and quotes are never receivables.
        .eq('document_type', 'invoice')
      query = isHistorical
        ? query.in('status', ['sent', 'overdue', 'credited', 'paid']).lte('invoice_date', asOfDate!)
        : query.in('status', ['sent', 'overdue', 'credited'])
      return query
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to)
    })

    if (isHistorical) {
      payments = await fetchPaymentsAsOf(supabase, 'invoice_payments', 'invoice_id', companyId, asOfDate!)
    }
  } catch {
    return {
      entries: [],
      total_outstanding: 0,
      total_current: 0,
      total_overdue: 0,
      unpaid_count: 0,
      unconverted_fx_count: 0,
    }
  }

  // Group by customer and calculate aging
  const byCustomer = new Map<string, ARLedgerEntry>()
  let unconvertedFxCount = 0

  for (const inv of invoices) {
    const customerId = inv.customer_id
    const customerName = inv.customer?.name || 'Okänd kund'

    if (!byCustomer.has(customerId)) {
      byCustomer.set(customerId, {
        customer_id: customerId,
        customer_name: customerName,
        invoices: [],
        current: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 0,
      })
    }

    const entry = byCustomer.get(customerId)!
    const dueDate = new Date(inv.due_date)
    const daysOverdue = Math.floor((refDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    const total = Number(inv.total) || 0
    const liveOutstanding = roundOre(total - (Number(inv.paid_amount) || 0))
    const outstanding = payments
      ? outstandingAsOf(inv, total, liveOutstanding, payments, asOfDate!)
      : liveOutstanding
    const paidAmount = roundOre(total - outstanding)

    // Historical view: 'paid' invoices are only fetched to catch ones still
    // open at the as-of date. One already settled by then adds nothing to the
    // reskontra, so skip its zero row instead of listing it.
    if (isHistorical && inv.status === 'paid' && outstanding === 0) continue

    // Aging buckets and totals must be in SEK so they reconcile with account 1510.
    // Foreign-currency invoices without an exchange_rate cannot be converted:
    // adding the raw foreign amount to a SEK total is unsound, so the row is
    // counted but excluded from the buckets. The detail row is still pushed so
    // the user can see the invoice in the expandable list, with outstanding_sek
    // = null to flag the missing conversion.
    const isFx = inv.currency && inv.currency !== 'SEK'
    const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
    const outstandingSek =
      isFx && !hasRate
        ? null
        : resolveSekAmount(outstanding, null, inv.currency, inv.exchange_rate)

    if (outstandingSek === null) unconvertedFxCount += 1

    // Add invoice detail (always: even if unconvertible, so it's visible)
    entry.invoices.push({
      invoice_id: inv.id,
      // Self-billing invoices we received have no own number: show the
      // counterparty's external number instead.
      invoice_number: inv.invoice_number || inv.external_invoice_number || '',
      invoice_date: inv.invoice_date || '',
      due_date: inv.due_date,
      total,
      paid_amount: paidAmount,
      outstanding,
      outstanding_sek: outstandingSek,
      days_overdue: Math.max(0, daysOverdue),
      currency: inv.currency || 'SEK',
    })

    if (outstandingSek === null) continue

    // Bucket by aging (in SEK)
    if (daysOverdue <= 0) {
      entry.current += outstandingSek
    } else if (daysOverdue <= 30) {
      entry.days_1_30 += outstandingSek
    } else if (daysOverdue <= 60) {
      entry.days_31_60 += outstandingSek
    } else if (daysOverdue <= 90) {
      entry.days_61_90 += outstandingSek
    } else {
      entry.days_90_plus += outstandingSek
    }

    entry.total_outstanding += outstandingSek
  }

  // Round all amounts and sort invoices within each customer.
  const entries = Array.from(byCustomer.values())
    .map((entry) => ({
      ...entry,
      invoices: entry.invoices.sort((a, b) => a.due_date.localeCompare(b.due_date)),
      current: Math.round(entry.current * 100) / 100,
      days_1_30: Math.round(entry.days_1_30 * 100) / 100,
      days_31_60: Math.round(entry.days_31_60 * 100) / 100,
      days_61_90: Math.round(entry.days_61_90 * 100) / 100,
      days_90_plus: Math.round(entry.days_90_plus * 100) / 100,
      total_outstanding: Math.round(entry.total_outstanding * 100) / 100,
    }))
    // Drop customers whose credit notes fully offset their open invoices
    // (net 0): a settled customer is noise in the reskontra. A total of 0
    // means two different things, though, and only one of them is "settled":
    // a customer whose open invoices were all unconvertible never accumulated
    // into the buckets at all, so its 0 is "unknown", not "nothing". Those
    // rows are the ones `unconverted_fx_count` promises the user can find, so
    // they must stay listed (with outstanding_sek = null) even though they
    // add nothing to the SEK totals.
    .filter(
      (entry) =>
        entry.total_outstanding !== 0 ||
        entry.invoices.some((inv) => inv.outstanding_sek === null)
    )

  // Sort by total outstanding descending
  entries.sort((a, b) => b.total_outstanding - a.total_outstanding)

  const total_outstanding = entries.reduce((sum, e) => sum + e.total_outstanding, 0)
  const total_current = entries.reduce((sum, e) => sum + e.current, 0)
  const total_overdue = total_outstanding - total_current
  const unpaid_count = entries.reduce(
    (sum, e) => sum + e.invoices.filter((i) => i.outstanding !== 0).length,
    0
  )

  return {
    entries,
    total_outstanding: Math.round(total_outstanding * 100) / 100,
    total_current: Math.round(total_current * 100) / 100,
    total_overdue: Math.round(total_overdue * 100) / 100,
    unpaid_count,
    unconverted_fx_count: unconvertedFxCount,
  }
}
