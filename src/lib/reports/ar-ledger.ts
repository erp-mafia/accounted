import type { SupabaseClient } from '@supabase/supabase-js'
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { OWED_INVOICE_STATUSES } from '@/lib/bookkeeping/matchable-statuses'
import { roundOre } from '@/lib/money'
import { outstandingAsOf, paymentsAsOfFromFacts } from './reskontra-payments'
import {
  fetchInvoiceRegisterCoverage,
  NO_INVOICE_REGISTER_COVERAGE,
  type InvoiceRegisterCoverage,
} from '@/lib/reports/invoice-register-coverage'
import {
  liveReceivableOutstanding,
  outstandingLessPayouts,
  skatteverketSettledByInvoice,
} from '@/lib/bookkeeping/skatteverket-share'
import { creditNoteCreditUsed, outstandingWithCreditUsed } from './credit-note-settlement'
import { fetchArLedgerInvoices, type ArLedgerInvoice } from './ar-ledger-invoices'
import { fetchReskontraIssueOre, reskontraShownTotal, withIssueOre } from './reskontra-issue-ore'
import type { IssueBookedFacts } from '@/lib/bookkeeping/ledger-carried-sek'
import { fetchCreditedInvoiceIds, netCreditedPairs } from './credited-pairs'
import { daysPastDue, todayIsoStockholm } from '@/lib/dates/iso'

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
  /**
   * Coverage of the invoice register this ledger is built from. A migrated
   * or backfilled company has invoices that exist only as journal entries;
   * this ledger cannot list them, and their 1510 balance is why the 1510
   * reconciliation shows a residual. Renderers show the boundary when
   * register_coverage.has_pre_register_invoices is true.
   */
  register_coverage: InvoiceRegisterCoverage
}

/**
 * Invoice statuses in the live kundreskontra. 'partially_paid' is as open as
 * 'sent' and 'overdue': the first partial payment moves an invoice there and
 * it stays until the rest is paid. 'credited' originals are kept so they net
 * against their credit notes; migrated credit notes that carry the same
 * status are left out (isSettledCreditNote). Paid invoices whose ROT/RUT
 * deduction Skatteverket has yet to pay out join them. The population read
 * (get_ar_ledger_invoices) spells these statuses out in SQL, and a pg test
 * holds the two together. The customer drill-down route and the 1510
 * reconciliation read that same population, so the aggregate and its detail
 * rows cannot drift apart.
 */
export const AR_LEDGER_STATUSES = [...OWED_INVOICE_STATUSES, 'credited'] as const

/**
 * Generate AR ledger (kundreskontra) with aging analysis.
 * BFL 5 kap. 4 §: sidoordnad bokföring: outstanding customer invoices with aging.
 *
 * With a backdated `asOfDate` the ledger is reconstructed as it stood on that
 * date: invoices dated on or before it (including ones fully paid since) with
 * outstanding amounts recomputed from the payment history (#1020). Without an
 * `asOfDate`, or with today/future, the live open-invoice state is used as-is.
 *
 * A failed read answers an empty ledger, which the screens show as "nothing
 * open". `strict` makes it throw instead: a caller that hands the total on as
 * a defined figure (lib/measures) must not report a failed read as zero.
 */
export async function generateARLedger(
  supabase: SupabaseClient,
  companyId: string,
  asOfDate?: string,
  options?: { strict?: boolean }
): Promise<ARLedgerReport> {
  const today = todayIsoStockholm()
  const asOf = asOfDate || today
  // Backdated reconstruction only kicks in for genuinely historical dates:
  // for today/future the stored open-invoice state IS the as-of state, and
  // the live view must stay byte-identical to what it always showed.
  const isHistorical = asOf < today

  // The ledger population, in one read (ar-ledger-invoices.ts). Live view:
  // open invoices, plus paid ones still awaiting Skatteverket's share of a
  // ROT/RUT deduction. Historical view: also invoices paid or written off
  // (konstaterad kundförlust) since the as-of date, restricted to invoice
  // dates on or before it, with the payment history; a claim written off by
  // then had left 1510 and is not returned. Invoices cancelled since are
  // treated as never having existed (their cancellation is not reliably
  // dated). The coverage disclosure is read beside it: non-fatal, the
  // ledger's own numbers do not depend on it, so a failed lookup degrades to
  // "no marker", never to an error.
  let invoices: ArLedgerInvoice[]
  let registerCoverage: InvoiceRegisterCoverage = NO_INVOICE_REGISTER_COVERAGE
  try {
    const [population, coverage] = await Promise.all([
      fetchArLedgerInvoices(supabase, companyId, { asOfDate: isHistorical ? asOfDate : undefined }),
      fetchInvoiceRegisterCoverage(supabase, companyId).catch(() => NO_INVOICE_REGISTER_COVERAGE),
    ])
    invoices = population
    registerCoverage = coverage
  } catch (err) {
    if (options?.strict) throw err
    return {
      entries: [],
      total_outstanding: 0,
      total_current: 0,
      total_overdue: 0,
      unpaid_count: 0,
      unconverted_fx_count: 0,
      register_coverage: NO_INVOICE_REGISTER_COVERAGE,
    }
  }

  const payments = isHistorical ? paymentsAsOfFromFacts(invoices) : null
  // The öresavrundning each invoice's issue verifikat put on 151x
  // (reskontra-issue-ore.ts). A failed read leaves the figures as the
  // invoices state them, off from 1510 by those öre only; `strict` throws.
  let issueOre: Map<string, IssueBookedFacts>
  try {
    issueOre = await fetchReskontraIssueOre(supabase, companyId, invoices)
  } catch (err) {
    if (options?.strict) throw err
    issueOre = new Map()
  }
  // A credit note whose verifikat paid another invoice has used that much
  // of its credit (credit-note-settlement.ts).
  const creditUsed = creditNoteCreditUsed(invoices, isHistorical ? asOfDate : undefined, issueOre)
  // What Skatteverket has paid out of each ROT/RUT deduction, which no
  // longer sits on 1513 (skatteverket-share.ts).
  const settled = skatteverketSettledByInvoice(invoices, isHistorical ? asOfDate : undefined)

  // Each row's open amount in its own currency, then each credit note set
  // against the invoice it credits (credited-pairs.ts): a fully credited
  // invoice and its credit note net to zero and neither is open or overdue;
  // a partial credit leaves the rest on the original. Totals do not move.
  const ownOutstanding = new Map<string, number>()
  for (const inv of invoices) {
    const total = Number(inv.total) || 0
    const liveOutstanding = roundOre(total - (Number(inv.paid_amount) || 0))
    const outstanding = payments ? outstandingAsOf(inv, total, liveOutstanding, payments, asOfDate!) : liveOutstanding
    const receivable = payments
      ? outstandingLessPayouts(outstanding, settled.get(inv.id))
      : liveReceivableOutstanding(inv, liveOutstanding, settled.get(inv.id))
    ownOutstanding.set(inv.id, outstandingWithCreditUsed(
      withIssueOre(receivable, outstanding, inv, issueOre.get(inv.id)?.ore),
      creditUsed.get(inv.id)
    ))
  }
  const creditNoteIds = invoices.filter(isCreditNoteDocument).map((inv) => inv.id)
  const creditedInvoiceOf = creditNoteIds.length > 0
    ? await fetchCreditedInvoiceIds(supabase, companyId, creditNoteIds)
    : new Map<string, string>()
  const paired = netCreditedPairs(invoices, ownOutstanding, creditedInvoiceOf)

  // Group by customer and calculate aging. An invoice without a customer
  // groups under a null customer_id.
  const byCustomer = new Map<string | null, ARLedgerEntry>()
  let unconvertedFxCount = 0

  // The population leaves settled credit notes out and comes grouped per
  // customer in first-seen order, so entries are created, and ties sorted
  // below, as an id-ordered walk of the whole population would.
  for (const inv of invoices) {
    const customerId = inv.customer_id
    const customerName = inv.customer_name || 'Okänd kund'

    if (!byCustomer.has(customerId)) {
      byCustomer.set(customerId, {
        customer_id: customerId as string,
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
    const daysOverdue = daysPastDue(inv.due_date, asOf)
    // What the issue verifikat booked, so Betalt stays what was paid.
    const total = reskontraShownTotal(inv, issueOre.get(inv.id)?.ore)
    const outstanding = paired.outstanding.get(inv.id) ?? 0
    const paidAmount = roundOre(total - outstanding)

    // 'paid' invoices are only fetched to catch ones still open: at the as-of
    // date, or (live) on a deduction Skatteverket has yet to pay out. One
    // settled by then adds nothing to the reskontra, so skip its zero row
    // instead of listing it. The same for a credited invoice with nothing
    // left on it and a credit note its original used up: settled by credit,
    // not open, so never listed as overdue.
    if (
      outstanding === 0 &&
      (inv.status === 'paid' || inv.status === 'credited' || paired.settledByCredit.has(inv.id))
    ) continue

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
      days_overdue: daysOverdue,
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
    register_coverage: registerCoverage,
  }
}
