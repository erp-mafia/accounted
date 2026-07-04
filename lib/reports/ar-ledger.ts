import type { SupabaseClient } from '@supabase/supabase-js'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'

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
 */
export async function generateARLedger(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string
): Promise<ARLedgerReport> {
  const refDate = asOfDate ? new Date(asOfDate) : new Date()

  // Fetch all unpaid/sent/overdue invoices with customer info
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let invoices: any[]
  try {
    invoices = await fetchAllRows(({ from, to }) =>
      supabase
        .from('invoices')
        .select('*, customer:customers(id, name)')
        .eq('company_id', companyId)
        .in('status', ['sent', 'overdue', 'credited'])
        // Stable total order for correct paging (see fetch-all.ts).
        .order('id', { ascending: true })
        .range(from, to)
    )
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
    const paidAmount = Number(inv.paid_amount) || 0
    const total = Number(inv.total) || 0
    const outstanding = Math.round((total - paidAmount) * 100) / 100

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
  // Drop customers whose credit notes fully offset their open invoices (net 0).
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
    .filter((entry) => entry.total_outstanding !== 0)

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
