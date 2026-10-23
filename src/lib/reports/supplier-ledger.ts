import type { SupabaseClient } from '@supabase/supabase-js'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { outstandingAsOf, paymentsAsOfFromFacts, todayIsoDate, type PaymentsAsOf } from './reskontra-payments'
import { fetchSupplierLedgerInvoices, type SupplierLedgerInvoice } from './supplier-ledger-invoices'

/**
 * One open supplier invoice behind a ledger entry. Only present when the
 * caller asks for it (`includeInvoices`): the screens and the v1/MCP ledger
 * doors read the per-supplier totals and keep their shape.
 */
export interface SupplierInvoiceDetail {
  supplier_invoice_id: string
  /** The supplier's own number, null when the document carries none. */
  supplier_invoice_number: string | null
  arrival_number: number | null
  invoice_date: string
  due_date: string
  currency: string
  /** Outstanding in the invoice's currency. */
  outstanding: number
  /** Outstanding in SEK at the invoice-date rate: the amount the totals add. */
  outstanding_sek: number
  days_overdue: number
}

export interface SupplierLedgerEntry {
  supplier_id: string
  supplier_name: string
  /** Present only with `includeInvoices`. */
  invoices?: SupplierInvoiceDetail[]
  current: number
  days_1_30: number
  days_31_60: number
  days_61_90: number
  days_90_plus: number
  total_outstanding: number
}

export interface SupplierLedgerReport {
  entries: SupplierLedgerEntry[]
  total_outstanding: number
  total_current: number
  total_overdue: number
  unpaid_count: number
  /**
   * Number of foreign-currency invoices excluded from the SEK totals because
   * they had no exchange_rate. Adding them would mix currencies; surfacing
   * the count lets the UI tell the user a row could not be converted.
   */
  unconverted_fx_count: number
}

/**
 * Generate supplier ledger (leverantörsreskontra) with aging analysis.
 *
 * With a backdated `asOfDate` the ledger is reconstructed as it stood on that
 * date: invoices dated on or before it (including ones fully paid since) with
 * outstanding amounts recomputed from the payment history (#1021). Without an
 * `asOfDate`, or with today/future, the live open-invoice state is used as-is.
 *
 * Options, both off by default so every existing caller is unchanged:
 * `strict` throws on a failed read instead of answering an empty ledger (a
 * caller that hands the total on as a defined figure, lib/measures, must not
 * report a failed read as zero); `includeInvoices` lists the open invoices
 * behind each entry, the amounts the totals add.
 */
export async function generateSupplierLedger(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string,
  options?: { strict?: boolean; includeInvoices?: boolean }
): Promise<SupplierLedgerReport> {
  const refDate = asOfDate ? new Date(asOfDate) : new Date()
  // Backdated reconstruction only for genuinely historical dates: for
  // today/future the stored open-invoice state IS the as-of state.
  const isHistorical = !!asOfDate && asOfDate < todayIsoDate()

  // Fetch the ledger population, in one read (supplier-ledger-invoices.ts).
  // Live view: open invoices only. Historical view: also invoices paid since
  // the as-of date, restricted to invoice dates on or before it, with the
  // payment history. Disputed/credited/reversed invoices stay excluded,
  // matching the live view's semantics.
  let invoices: SupplierLedgerInvoice[]
  let payments: PaymentsAsOf | null = null
  try {
    invoices = await fetchSupplierLedgerInvoices(supabase, companyId, {
      asOfDate: isHistorical ? asOfDate : undefined,
    })
    if (isHistorical) payments = paymentsAsOfFromFacts(invoices)
  } catch (err) {
    if (options?.strict) throw err
    return {
      entries: [],
      total_outstanding: 0,
      total_current: 0,
      total_overdue: 0,
      unpaid_count: 0,
      unconverted_fx_count: 0,
    }
  }

  // Group by supplier and calculate aging
  const bySupplier = new Map<string, SupplierLedgerEntry>()
  let unconvertedFxCount = 0
  let settledSkipped = 0

  for (const inv of invoices) {
    const supplierId = inv.supplier_id
    const supplierName = inv.supplier_name || 'Okänd leverantör'

    // Foreign-currency invoice with no exchange_rate cannot be converted to
    // SEK; adding the raw foreign amount to a SEK total would be unsound, so
    // the row is excluded from sums and only counted.
    const isFx = inv.currency && inv.currency !== 'SEK'
    const hasRate = inv.exchange_rate != null && Number(inv.exchange_rate) > 0
    if (isFx && !hasRate) {
      unconvertedFxCount += 1
      continue
    }

    // Outstanding in invoice currency: live view trusts the stored
    // remaining_amount; a historical view recomputes it from the payment
    // history as of the reconstruction date.
    const liveOutstanding = Number(inv.remaining_amount) || 0
    const outstandingRaw = payments
      ? outstandingAsOf(inv, Number(inv.total) || 0, liveOutstanding, payments, asOfDate!)
      : liveOutstanding

    // Historical view: 'paid' invoices are only fetched to catch ones still
    // open at the as-of date. One already settled by then adds nothing.
    if (payments && inv.status === 'paid' && outstandingRaw === 0) {
      settledSkipped += 1
      continue
    }

    if (!bySupplier.has(supplierId)) {
      bySupplier.set(supplierId, {
        supplier_id: supplierId,
        supplier_name: supplierName,
        current: 0,
        days_1_30: 0,
        days_31_60: 0,
        days_61_90: 0,
        days_90_plus: 0,
        total_outstanding: 0,
        ...(options?.includeInvoices ? { invoices: [] } : {}),
      })
    }

    const entry = bySupplier.get(supplierId)!
    const dueDate = new Date(inv.due_date)
    const daysOverdue = Math.floor((refDate.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    // Outstanding is in invoice currency. The 2440 GL line was posted in SEK
    // at the invoice-date rate, so we convert here for the reconciliation.
    const amount = resolveSekAmount(outstandingRaw, null, inv.currency, inv.exchange_rate)

    entry.invoices?.push({
      supplier_invoice_id: inv.id,
      supplier_invoice_number: inv.supplier_invoice_number ?? null,
      arrival_number: inv.arrival_number ?? null,
      invoice_date: inv.invoice_date || '',
      due_date: inv.due_date,
      currency: inv.currency || 'SEK',
      outstanding: outstandingRaw,
      outstanding_sek: amount,
      days_overdue: Math.max(0, daysOverdue),
    })

    if (daysOverdue <= 0) {
      entry.current += amount
    } else if (daysOverdue <= 30) {
      entry.days_1_30 += amount
    } else if (daysOverdue <= 60) {
      entry.days_31_60 += amount
    } else if (daysOverdue <= 90) {
      entry.days_61_90 += amount
    } else {
      entry.days_90_plus += amount
    }

    entry.total_outstanding += amount
  }

  const entries = Array.from(bySupplier.values())
    .sort((a, b) => b.total_outstanding - a.total_outstanding)

  const total_outstanding = entries.reduce((sum, e) => sum + e.total_outstanding, 0)
  const total_current = entries.reduce((sum, e) => sum + e.current, 0)
  const total_overdue = total_outstanding - total_current

  return {
    entries,
    total_outstanding: Math.round(total_outstanding * 100) / 100,
    total_current: Math.round(total_current * 100) / 100,
    total_overdue: Math.round(total_overdue * 100) / 100,
    unpaid_count: invoices.length - settledSkipped,
    unconverted_fx_count: unconvertedFxCount,
  }
}
