/**
 * Kontantmetoden year-end cut-off (BFL 5 kap 2 §).
 *
 * Under kontantmetoden (bokslutsmetoden) affärshändelser are booked when cash
 * moves, so open customer and supplier invoices never reach 1510 / 2440 during
 * the year. BFL still requires that fordringar och skulder ARE booked at
 * räkenskapsårets utgång, so the year-end needs a cut-off entry that puts every
 * still-outstanding invoice onto the balance sheet.
 *
 * Moms is the part that is easy to get wrong. Under bokslutsmetoden moms is
 * reported at payment, so the cut-off must NOT push moms into the current
 * momsdeklaration. BAS provides "vilande" (dormant) moms accounts for exactly
 * this: 2618/2628/2638 for utgående and 2648 for ingående. They are absent from
 * ACCOUNT_RUTA / ACCOUNT_TO_BOX by design, so anything parked there stays out
 * of the declaration until the invoice is actually paid. Booking cut-off moms
 * to 2611/2641 instead would claim it a period early, which is the real error
 * this module exists to avoid.
 *
 * Shape: two aggregate verifikat (one for fordringar, one for skulder), each
 * reversed on the first day of the following period. Deliberately NOT
 * per-invoice, and deliberately not linked through invoices.journal_entry_id:
 *
 *  - the payment flows route on whether a live journal-entry link exists, so
 *    linking here would make every new-year payment take the accrual clearing
 *    path against a receivable the reversal has already removed, booking the
 *    settlement twice;
 *  - leaving the link unset means a new-year payment still books the normal
 *    kontantmetoden cash entry (revenue/expense + real moms at the payment
 *    date), which is what bokslutsmetoden requires.
 *
 * The reversal is what makes that safe: cut-off on the last day of the year,
 * vändning on the first day of the next, and the ledger is back to a pure cash
 * basis before any new-year payment is booked.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryLineInput,
  EntityType,
  JournalEntry,
  VatTreatment,
} from '@/types'
import { getRevenueAccount } from '@/lib/bookkeeping/invoice-entries'
import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { createLogger } from '@/lib/logger'
import { ORE_TOLERANCE, roundOre } from '@/lib/money'

const log = createLogger('kontantmetod-cutoff')

/**
 * Vilande utgående moms per VAT treatment. Rates outside 25/12/6 (export,
 * reverse charge, exempt) carry no Swedish output moms at all, so they never
 * reach this map: their whole outstanding amount is revenue.
 */
export const VILANDE_OUTPUT_VAT_ACCOUNTS: Partial<Record<VatTreatment, string>> = {
  standard_25: '2618',
  reduced_12: '2628',
  reduced_6: '2638',
}

/** Vilande ingående moms. One account for every rate, mirroring 2641. */
export const VILANDE_INPUT_VAT_ACCOUNT = '2648'

export const RECEIVABLES_ACCOUNT = '1510'
export const PAYABLES_ACCOUNT = '2440'

/** A customer invoice still outstanding at period end. Amounts are SEK. */
export interface CutoffReceivable {
  id: string
  /** Human reference for the line description. */
  reference: string
  vatTreatment: VatTreatment
  /** Outstanding INCLUDING moms at period end. */
  outstanding: number
  /** The moms share of `outstanding`. */
  vat: number
}

/** A supplier invoice still outstanding at period end. Amounts are SEK. */
export interface CutoffPayable {
  id: string
  reference: string
  /** Outstanding INCLUDING moms at period end. */
  outstanding: number
  /** The ingående moms share of `outstanding`. */
  vat: number
  /**
   * Net expense split across BAS accounts, as weights. Only the ratios matter:
   * the net total is always derived as `outstanding - vat` so the verifikat
   * balances no matter how the source rows round.
   */
  netByAccount: Array<{ account: string; amount: number }>
}

export interface CutoffLines {
  receivableLines: CreateJournalEntryLineInput[]
  payableLines: CreateJournalEntryLineInput[]
  receivableTotal: number
  payableTotal: number
}

// Go through roundOre first: Math.round(x * 100) alone mis-rounds exact-half
// values that arrive with float drift (lib/money.ts).
const toOre = (amount: number): number => Math.round(roundOre(amount) * 100)
const toKronor = (ore: number): number => ore / 100

/**
 * Split `totalOre` across `weights` so the parts sum to exactly `totalOre`.
 *
 * Proportional shares with largest-remainder allocation. Doing this in whole
 * öre (rather than rounding each share independently) is what keeps the
 * verifikat balanced: independent rounding drifts by an öre per bucket and the
 * DB balance trigger would reject the entry.
 */
export function distributeOre(totalOre: number, weights: number[]): number[] {
  if (weights.length === 0) return []
  if (weights.length === 1) return [totalOre]

  const weightSum = weights.reduce((sum, w) => sum + Math.abs(w), 0)
  // Degenerate input (all-zero weights): put everything on the first bucket
  // rather than emitting NaN.
  if (weightSum === 0) return weights.map((_, i) => (i === 0 ? totalOre : 0))

  const exact = weights.map((w) => (Math.abs(w) / weightSum) * totalOre)
  const floors = exact.map((value) => Math.floor(value))
  let remainder = totalOre - floors.reduce((sum, value) => sum + value, 0)

  // Hand the leftover öre to the largest fractional parts first.
  const order = exact
    .map((value, index) => ({ index, frac: value - Math.floor(value) }))
    .sort((a, b) => b.frac - a.frac)

  const result = [...floors]
  for (const { index } of order) {
    if (remainder <= 0) break
    result[index] += 1
    remainder -= 1
  }
  return result
}

/**
 * Build the cut-off verifikat lines. Pure: no IO, so the money math is
 * directly testable.
 *
 * Receivables: Debit 1510 / Credit 30xx + Credit 2618|2628|2638
 * Payables:    Debit 4-6xxx + Debit 2648 / Credit 2440
 */
export function buildCutoffLines(
  receivables: CutoffReceivable[],
  payables: CutoffPayable[],
  entityType: EntityType = 'aktiebolag',
): CutoffLines {
  const receivableLines: CreateJournalEntryLineInput[] = []
  const payableLines: CreateJournalEntryLineInput[] = []

  // ---- Fordringar -------------------------------------------------------
  // Group by VAT treatment: the revenue account and the vilande moms account
  // both follow from it.
  const revenueByTreatment = new Map<VatTreatment, number>()
  const outputVatByTreatment = new Map<VatTreatment, number>()
  let receivableOre = 0

  for (const row of receivables) {
    const outstandingOre = toOre(row.outstanding)
    if (outstandingOre === 0) continue
    // Derive net from outstanding minus moms so the two legs always add back
    // to the receivable, whatever rounding the source row carries.
    const vatOre = toOre(row.vat)
    const netOre = outstandingOre - vatOre

    receivableOre += outstandingOre
    revenueByTreatment.set(row.vatTreatment, (revenueByTreatment.get(row.vatTreatment) ?? 0) + netOre)
    if (vatOre !== 0) {
      outputVatByTreatment.set(
        row.vatTreatment,
        (outputVatByTreatment.get(row.vatTreatment) ?? 0) + vatOre,
      )
    }
  }

  if (receivableOre !== 0) {
    receivableLines.push({
      account_number: RECEIVABLES_ACCOUNT,
      debit_amount: toKronor(receivableOre),
      credit_amount: 0,
      line_description: 'Kundfordringar vid räkenskapsårets utgång (kontantmetoden)',
    })

    for (const [treatment, netOre] of revenueByTreatment) {
      if (netOre === 0) continue
      receivableLines.push({
        account_number: getRevenueAccount(treatment, entityType),
        debit_amount: 0,
        credit_amount: toKronor(netOre),
        line_description: 'Obetalda kundfakturor vid bokslut',
      })
    }

    for (const [treatment, vatOre] of outputVatByTreatment) {
      const account = VILANDE_OUTPUT_VAT_ACCOUNTS[treatment]
      // No vilande account means the treatment carries no Swedish output moms
      // (export, omvänd betalningsskyldighet, undantagen). A non-zero moms
      // amount there is a data error: fold it into revenue rather than invent
      // a moms account, so the verifikat still balances and the anomaly shows
      // up as revenue rather than as a phantom momsskuld.
      if (!account) {
        log.warn('outstanding moms on a treatment with no vilande account; booked as revenue', {
          treatment,
          ore: vatOre,
        })
        receivableLines.push({
          account_number: getRevenueAccount(treatment, entityType),
          debit_amount: 0,
          credit_amount: toKronor(vatOre),
          line_description: 'Obetalda kundfakturor vid bokslut',
        })
        continue
      }
      receivableLines.push({
        account_number: account,
        debit_amount: 0,
        credit_amount: toKronor(vatOre),
        line_description: 'Vilande utgående moms, redovisas vid betalning',
      })
    }
  }

  // ---- Skulder ----------------------------------------------------------
  const expenseByAccount = new Map<string, number>()
  let payableOre = 0
  let inputVatOre = 0

  for (const row of payables) {
    const outstandingOre = toOre(row.outstanding)
    if (outstandingOre === 0) continue
    const vatOre = toOre(row.vat)
    const netOre = outstandingOre - vatOre

    payableOre += outstandingOre
    inputVatOre += vatOre

    const buckets = row.netByAccount.length > 0
      ? row.netByAccount
      // No item detail: park the net on the generic övriga kostnader account
      // rather than dropping it. The entry is reversed the next day, so the
      // account choice never survives into the new year.
      : [{ account: '6990', amount: 1 }]
    const shares = distributeOre(netOre, buckets.map((b) => b.amount))
    buckets.forEach((bucket, index) => {
      const share = shares[index]
      if (share === 0) return
      expenseByAccount.set(bucket.account, (expenseByAccount.get(bucket.account) ?? 0) + share)
    })
  }

  if (payableOre !== 0) {
    for (const [account, netOre] of expenseByAccount) {
      if (netOre === 0) continue
      payableLines.push({
        account_number: account,
        debit_amount: toKronor(netOre),
        credit_amount: 0,
        line_description: 'Obetalda leverantörsfakturor vid bokslut',
      })
    }

    if (inputVatOre !== 0) {
      payableLines.push({
        account_number: VILANDE_INPUT_VAT_ACCOUNT,
        debit_amount: toKronor(inputVatOre),
        credit_amount: 0,
        line_description: 'Vilande ingående moms, dras av vid betalning',
      })
    }

    payableLines.push({
      account_number: PAYABLES_ACCOUNT,
      debit_amount: 0,
      credit_amount: toKronor(payableOre),
      line_description: 'Leverantörsskulder vid räkenskapsårets utgång (kontantmetoden)',
    })
  }

  return {
    receivableLines,
    payableLines,
    receivableTotal: toKronor(receivableOre),
    payableTotal: toKronor(payableOre),
  }
}

/** Swap every debit and credit: the vändning posted on day 1 of the new year. */
export function reverseLines(
  lines: CreateJournalEntryLineInput[],
): CreateJournalEntryLineInput[] {
  return lines.map((line) => ({
    ...line,
    debit_amount: line.credit_amount,
    credit_amount: line.debit_amount,
    line_description: `Vändning: ${line.line_description ?? ''}`.trim(),
  }))
}

/** The day after `date`, ISO. Used to date the vändning. */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export interface CutoffCollection {
  receivables: CutoffReceivable[]
  payables: CutoffPayable[]
}

/**
 * Fetch every invoice still outstanding at `periodEnd`.
 *
 * "Outstanding at period end" is deliberately payment-DATE based, not the
 * current remaining_amount: an invoice settled in January was still a
 * fordran on 31 December and must be part of the cut-off. Reading
 * remaining_amount would silently shrink the cut-off every day the user
 * delays running the bokslut.
 */
export async function collectKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  periodStart: string,
  periodEnd: string,
): Promise<CutoffCollection> {
  const [invoicesResult, supplierResult] = await Promise.all([
    supabase
      .from('invoices')
      .select('id, invoice_number, invoice_date, status, total, total_sek, vat_amount, vat_amount_sek, vat_treatment, credited_invoice_id, document_type')
      .eq('company_id', companyId)
      .lte('invoice_date', periodEnd)
      .in('status', ['sent', 'overdue', 'partially_paid', 'paid']),
    supabase
      .from('supplier_invoices')
      .select('id, supplier_invoice_number, invoice_date, status, total, total_sek, vat_amount, vat_amount_sek, is_credit_note, items:supplier_invoice_items(account_number, line_total)')
      .eq('company_id', companyId)
      .lte('invoice_date', periodEnd)
      .in('status', ['registered', 'approved', 'partially_paid', 'paid']),
  ])

  const invoices = (invoicesResult.data ?? []) as Array<Record<string, unknown>>
  const supplierInvoices = (supplierResult.data ?? []) as Array<Record<string, unknown>>

  const invoiceIds = invoices.map((row) => row.id as string)
  const supplierIds = supplierInvoices.map((row) => row.id as string)

  // Payments ON OR BEFORE period end reduce the outstanding balance; later
  // ones must not.
  const [invoicePayments, supplierPayments] = await Promise.all([
    invoiceIds.length > 0
      ? supabase
          .from('invoice_payments')
          .select('invoice_id, amount, payment_date')
          .eq('company_id', companyId)
          .lte('payment_date', periodEnd)
          .in('invoice_id', invoiceIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    supplierIds.length > 0
      ? supabase
          .from('supplier_invoice_payments')
          .select('supplier_invoice_id, amount, payment_date')
          .eq('company_id', companyId)
          .lte('payment_date', periodEnd)
          .in('supplier_invoice_id', supplierIds)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
  ])

  const paidByInvoice = new Map<string, number>()
  for (const row of (invoicePayments.data ?? []) as Array<Record<string, unknown>>) {
    const id = row.invoice_id as string
    paidByInvoice.set(id, (paidByInvoice.get(id) ?? 0) + Number(row.amount ?? 0))
  }
  const paidBySupplierInvoice = new Map<string, number>()
  for (const row of (supplierPayments.data ?? []) as Array<Record<string, unknown>>) {
    const id = row.supplier_invoice_id as string
    paidBySupplierInvoice.set(id, (paidBySupplierInvoice.get(id) ?? 0) + Number(row.amount ?? 0))
  }

  const receivables: CutoffReceivable[] = []
  for (const row of invoices) {
    // Credit notes reduce the receivable through their own negative totals;
    // they are already part of the invoice set, so no special casing beyond
    // skipping non-invoice document types (offers, delivery notes).
    const documentType = row.document_type as string | null
    if (documentType && documentType !== 'invoice') continue

    const total = Number(row.total_sek ?? row.total ?? 0)
    const vat = Number(row.vat_amount_sek ?? row.vat_amount ?? 0)
    const paid = paidByInvoice.get(row.id as string) ?? 0
    const outstanding = roundOre(total - paid)
    if (Math.abs(outstanding) < ORE_TOLERANCE) continue

    // Scale the moms share to the part still outstanding: a half-paid invoice
    // carries half its moms into the cut-off.
    const ratio = total === 0 ? 0 : outstanding / total
    receivables.push({
      id: row.id as string,
      reference: (row.invoice_number as string) ?? '',
      vatTreatment: (row.vat_treatment as VatTreatment) ?? 'standard_25',
      outstanding,
      vat: roundOre(vat * ratio),
    })
  }

  const payables: CutoffPayable[] = []
  for (const row of supplierInvoices) {
    const total = Number(row.total_sek ?? row.total ?? 0)
    const vat = Number(row.vat_amount_sek ?? row.vat_amount ?? 0)
    const paid = paidBySupplierInvoice.get(row.id as string) ?? 0
    const outstanding = roundOre(total - paid)
    if (Math.abs(outstanding) < ORE_TOLERANCE) continue

    const ratio = total === 0 ? 0 : outstanding / total
    const items = (row.items ?? []) as Array<Record<string, unknown>>
    payables.push({
      id: row.id as string,
      reference: (row.supplier_invoice_number as string) ?? '',
      outstanding,
      vat: roundOre(vat * ratio),
      netByAccount: items
        .filter((item) => item.account_number)
        .map((item) => ({
          account: item.account_number as string,
          amount: Math.abs(Number(item.line_total ?? 0)),
        })),
    })
  }

  log.info('collected kontantmetoden cut-off', {
    companyId,
    periodStart,
    periodEnd,
    receivables: receivables.length,
    payables: payables.length,
  })

  return { receivables, payables }
}

export interface PostCutoffResult {
  receivableEntry: JournalEntry | null
  receivableReversal: JournalEntry | null
  payableEntry: JournalEntry | null
  payableReversal: JournalEntry | null
}

/**
 * Post the cut-off verifikat and their vändningar.
 *
 * The reversal is posted into `nextFiscalPeriodId`; when the next period does
 * not exist yet the cut-off is refused outright rather than posted half-done.
 * A cut-off without its vändning would leave 1510/2440 permanently inflated
 * and every new-year payment would double-book.
 */
export async function postKontantmetodCutoff(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  opts: {
    fiscalPeriodId: string
    nextFiscalPeriodId: string
    periodEnd: string
    receivables: CutoffReceivable[]
    payables: CutoffPayable[]
    entityType?: EntityType
  },
): Promise<PostCutoffResult> {
  const { receivableLines, payableLines } = buildCutoffLines(
    opts.receivables,
    opts.payables,
    opts.entityType,
  )
  const reversalDate = nextDay(opts.periodEnd)

  const result: PostCutoffResult = {
    receivableEntry: null,
    receivableReversal: null,
    payableEntry: null,
    payableReversal: null,
  }

  if (receivableLines.length > 0) {
    result.receivableEntry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: opts.fiscalPeriodId,
      entry_date: opts.periodEnd,
      description: 'Kundfordringar vid bokslut (kontantmetoden)',
      source_type: 'year_end',
      lines: receivableLines,
    })
    result.receivableReversal = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: opts.nextFiscalPeriodId,
      entry_date: reversalDate,
      description: 'Vändning kundfordringar bokslut (kontantmetoden)',
      source_type: 'year_end',
      lines: reverseLines(receivableLines),
    })
  }

  if (payableLines.length > 0) {
    result.payableEntry = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: opts.fiscalPeriodId,
      entry_date: opts.periodEnd,
      description: 'Leverantörsskulder vid bokslut (kontantmetoden)',
      source_type: 'year_end',
      lines: payableLines,
    })
    result.payableReversal = await createJournalEntry(supabase, companyId, userId, {
      fiscal_period_id: opts.nextFiscalPeriodId,
      entry_date: reversalDate,
      description: 'Vändning leverantörsskulder bokslut (kontantmetoden)',
      source_type: 'year_end',
      lines: reverseLines(payableLines),
    })
  }

  return result
}
