import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import { createJournalEntry, findFiscalPeriod } from './engine'
import { resolveSekAmount, buildCurrencyMetadata } from './currency-utils'
import { fxDifferenceLine } from './ore-rounding'
import { resolveBookingAccount } from './accruals/account-suggestions'
import { buildSupplierDescription, supplierInvoiceReference } from './supplier-invoice-description'
import {
  generateReverseChargePurchaseLines,
  resolveReverseChargeRate,
  reverseChargeKindForSupplierType,
  reverseChargeOnAccount,
  type ChartVatTreatments,
} from './vat-entries'
import { fetchChartVatTreatments } from './chart-vat-treatments'
import { generateSlpLines, isSlpPensionAccount } from './slp-lines'
import { treatmentDeductsInputVat } from '@/lib/vat/supplier-invoice-line-checks'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  mergeDimensionBags,
  type LineDimensions,
} from './dimension-resolver'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import { creditNatural, debitNatural } from './line-side'
import { isSupplierInvoiceRoundingItem } from '@/lib/supplier-invoices/rounding-item'
import { supplierInvoiceTotalsTolerance } from '@/lib/supplier-invoices/line-totals'
import {
  addSupplierBankFeeLine,
  buildSupplierPaymentClearingLines,
  resolveSupplierCashSettlement,
  supplierOreRoundingLine,
} from './supplier-payment-lines'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ExpenseClaimLineInput } from '@/lib/expenses/expense-claims-service'
import type {
  CreateJournalEntryInput,
  Transaction,
  CreateJournalEntryLineInput,
  JournalEntry,
  SupplierInvoice,
  SupplierInvoiceItem,
} from '@/types'

const log = createLogger('supplier-invoice-entries')

/**
 * Stable code for the "foreign-currency supplier invoice without a rate"
 * refusal. Registered in lib/errors/structured-errors.ts so REST routes, the
 * MCP server and getErrorMessage() all translate it the same way.
 */
export const SI_FX_RATE_MISSING = 'SI_FX_RATE_MISSING' as const

/**
 * BAS account credited for a supplier payment when the caller names none.
 * 1930 Företagskonto is the default business bank account in the BAS chart.
 *
 * Every surface that books or previews a supplier payment resolves the credit
 * account the same way: an explicit account wins, otherwise this. Named here
 * so no route re-spells '1930' and quietly drifts from the generators, which
 * are the only place that fallback may be decided. Issue #2550.
 */
export const DEFAULT_SUPPLIER_PAYMENT_ACCOUNT = '1930' as const

/**
 * Raised when a booking path is asked to translate a foreign-currency supplier
 * invoice that has no usable exchange rate.
 *
 * resolveSekAmount() answers that case by returning the RAW foreign amount (a
 * legacy "assume SEK" fallback that is tolerable in read-only code but not
 * when posting a verifikat): a 1 000 EUR invoice would post as 1 000 SEK, and
 * because every leg is scaled by the same wrong factor the entry still
 * balances, so no DB trigger fires and nothing errors. Under omvänd
 * skattskyldighet that silently books 250,00 kr of fiktiv moms on 2614/2645
 * instead of 2 875,00 kr at 11,50 SEK/EUR, understating both ruta 20 (or 21)
 * and ruta 30 of the momsdeklaration by the same amount: an oriktig uppgift
 * exposed to skattetillägg under SFL 49 kap 4 §.
 *
 * The in-house precedent for failing loudly instead is the
 * `match_batch_allocate` RPC, which hard-fails with BATCH_FX_RATE_MISSING, and
 * lib/reports/supplier-ledger.ts, which skips any FX invoice lacking a rate
 * rather than faking a 1:1 conversion.
 */
export class SupplierInvoiceFxRateMissingError extends Error {
  readonly code = SI_FX_RATE_MISSING
  constructor(public readonly currency: string) {
    super(
      `Supplier invoice is in ${currency} but has no exchange rate on file; refusing to post it as if 1 ${currency} = 1 SEK.`
    )
    this.name = 'SupplierInvoiceFxRateMissingError'
  }
}

/**
 * The least a credit note's tolerance ever is, in SEK (see
 * creditNotePayableToleranceSek). The rows are compared in SEK, where each
 * cost bucket and moms group of a foreign invoice is rounded to the öre on
 * its own. The registration's rule counts in the invoice's currency and knows
 * nothing of that rounding, which outgrows it at a rate below 1 SEK.
 */
const CREDIT_NOTE_PAYABLE_TOLERANCE_FLOOR_SEK = 1

/**
 * How far a credit note's reversal of the rows may sit from the invoice's
 * payable, in SEK, before it is refused: what the registration itself accepts
 * between a document total and its lines (supplierInvoiceTotalsTolerance:
 * öresavrundning plus per-line moms rounding, capped), at the invoice's rate,
 * and never under the floor. One rule for both: what the registration
 * accepts as rounding, the credit note accepts too.
 */
function creditNotePayableToleranceSek(
  invoice: Pick<SupplierInvoice, 'currency' | 'exchange_rate'>,
  lineCount: number,
): number {
  const rate = invoice.currency !== 'SEK' && invoice.exchange_rate != null && invoice.exchange_rate > 0
    ? invoice.exchange_rate
    : 1
  return Math.max(CREDIT_NOTE_PAYABLE_TOLERANCE_FLOOR_SEK, supplierInvoiceTotalsTolerance(lineCount) * rate)
}

/**
 * Raised, before anything is posted, when a credit note built from the
 * original's rows would move 244x by another amount than the original's
 * payable: the rows do not add up to their invoice (duplicated, missing,
 * stored without their sign, or not there at all, as on some migrated
 * invoices). Posting it would leave 2440 off by the difference while the
 * reskontra shows nothing left.
 */
export class SupplierCreditNoteRowsMismatchError extends Error {
  constructor(
    public readonly rowsPayableSek: number,
    public readonly invoicePayableSek: number,
  ) {
    super(
      `The invoice's rows reverse ${rowsPayableSek} SEK on 244x, but the invoice's payable is ${invoicePayableSek} SEK; refusing to post a credit note that does not match it.`
    )
    this.name = 'SupplierCreditNoteRowsMismatchError'
  }
}

/**
 * Convert an invoice-currency amount to SEK for a journal entry line.
 *
 * SEK invoices short-circuit exactly as before, and so does any invoice with a
 * legitimately supplied positive rate: the only new behaviour is the refusal
 * above when a foreign invoice reaches a booking path with no rate at all.
 * Every conversion in this file goes through here so no leg (expense, moms,
 * fiktiv moms, basbelopp, 2440) can be posted at a fabricated 1:1 rate.
 * Exported for the paths that must reproduce a posted registration's SEK
 * figures exactly (lib/supplier-invoices/item-account.ts).
 */
export function toSekOrThrow(
  amount: number,
  currency: string,
  exchangeRate: number | null | undefined
): number {
  if (currency && currency !== 'SEK' && !(exchangeRate != null && exchangeRate > 0)) {
    throw new SupplierInvoiceFxRateMissingError(currency)
  }
  return resolveSekAmount(amount, null, currency, exchangeRate)
}

/**
 * Aggregate item amounts per (booking account, merged dimensions bag):
 * dimensions PR7. The merged bag (item.dimensions over the invoice's
 * default_dimensions) is part of the aggregation identity so two items on the
 * same account but different tags stay on separate journal lines instead of
 * collapsing. Insertion order is first-seen, matching the old per-account map.
 */
interface ExpenseBucket {
  account: string
  dimensions?: LineDimensions
  amount: number
}

function groupExpenseBuckets(
  items: SupplierInvoiceItem[],
  resolveAccount: (item: SupplierInvoiceItem) => string,
  toSek: (item: SupplierInvoiceItem) => number,
  defaultDimensions?: LineDimensions
): ExpenseBucket[] {
  const buckets = new Map<string, ExpenseBucket>()
  for (const item of items) {
    const account = resolveAccount(item)
    const dimensions = mergeDimensionBags(defaultDimensions, item.dimensions)
    const key = `${account}\u0000${dimensionsBagKey(dimensions)}`
    const bucket = buckets.get(key) ?? { account, dimensions, amount: 0 }
    bucket.amount += toSek(item)
    buckets.set(key, bucket)
  }
  return [...buckets.values()]
}

/**
 * Create journal entry when a supplier invoice is registered (accrual method)
 *
 * Swedish domestic (25% VAT):
 *   Debit  5xxx/6xxx (per item's account_number)   [item line_total]
 *   Debit  2641 Ingående moms (per rate)            [VAT per rate group]
 *   Credit 2440 Leverantörsskulder                  [total incl VAT]
 *
 * EU/non-EU reverse charge (services):
 *   Debit  5xxx/6xxx (per item)                     [total]
 *   Debit  2645 Beräknad ingående moms (per rate)   [fiktiv VAT per rate]
 *   Credit 26x4 Utgående moms omvänd (per rate)     [fiktiv VAT per rate]
 *   Credit 2440 Leverantörsskulder                  [total]
 *
 * Exempt / export (vat_treatment says the invoice carries no Swedish moms):
 *   Debit  5xxx/6xxx (per item's account_number)    [gross, no 2641 at all]
 *   Credit 2440 Leverantörsskulder                  [same gross]
 *
 * Note: Goods imports via Tullverket (customs) use a different accounting path
 * (2615/2645) and are not handled here: only services use reverse charge.
 */
export async function createSupplierInvoiceRegistrationEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  supplierName?: string
): Promise<JournalEntry | null> {
  const input = await buildSupplierInvoiceRegistrationEntryInput(
    supabase, companyId, invoice, items, supplierType, supplierName
  )
  if (!input) return null
  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * The registration verifikat createSupplierInvoiceRegistrationEntry would
 * post, without posting it: the fiscal period lookup (and, for a
 * reverse-charge invoice, the company's momskoder) are the only database
 * reads, and nothing is written. The deferred "Bokför" dry run previews these
 * lines. Returns null when no open fiscal period covers invoice_date. Throws
 * the same generator errors (SupplierInvoiceFxRateMissingError) the
 * committing path throws.
 */
export async function buildSupplierInvoiceRegistrationEntryInput(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  supplierName?: string
): Promise<CreateJournalEntryInput | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, invoice.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for invoice date:', invoice.invoice_date)
    return null
  }

  const desc = buildSupplierDescription('Leverantörsfaktura', invoice.supplier_invoice_number, supplierName, `(ankomstnr ${invoice.arrival_number})`)
  const lines = await buildSupplierInvoiceRowLines(supabase, companyId, invoice, items, supplierType, desc)

  // Credit: Leverantörsskulder, balance guarantee: ensures sum(debits) === sum(credits)
  // For reverse charge, intermediate credits (2614/2624/2634) already exist, so we subtract them
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const isForeign = invoice.currency !== 'SEK'
  // An invoice whose rows net below zero (a leverantörskreditfaktura keyed in
  // as an invoice) books 2440 on the debit side instead of a negative credit.
  lines.push({
    account_number: '2440',
    ...creditNatural(totalDebits - totalCredits),
    line_description: desc,
    dimensions: coerceDimensionsBag(invoice.default_dimensions),
    ...buildCurrencyMetadata(invoice.currency, isForeign ? invoice.total : undefined, invoice.exchange_rate),
  })

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: invoice.invoice_date,
    description: desc,
    source_type: 'supplier_invoice_registered',
    source_id: invoice.id,
    lines,
  }

  return input
}

/**
 * Every line the registration books for the invoice's rows, all but the skuld
 * on 2440: cost per (account, dimensions), ingående moms per rate or the
 * reverse-charge sets, and the SLP pair, each on the side the row's sign
 * gives it. The kreditfaktura (createSupplierCreditNoteEntry) books these same
 * lines on the other side, so an invoice and its credit note net to zero on
 * every account and dimension cell, a row that nets to a credit (rabatt,
 * öresavrundning downwards, the output side of a reverse charge) included.
 * The company's momskoder are read only for a reverse-charge invoice.
 */
async function buildSupplierInvoiceRowLines(
  supabase: SupabaseClient,
  companyId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  desc: string,
): Promise<CreateJournalEntryLineInput[]> {
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: expense lines carry item bags merged over the invoice
  // default; every other line (VAT, RC/basis, 2440) carries the default only.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Aggregate expense amounts by (account, dimensions) and convert to SEK.
  // Periodiserade lines book their net to the 17xx interim account instead
  // of the cost account (resolveBookingAccount); VAT and 2440 are untouched:
  // moms is never deferred (redovisas på fakturadatum).
  const expenseBuckets = groupExpenseBuckets(
    items,
    (item) => resolveBookingAccount('expense', item, item.account_number),
    (item) => toSekOrThrow(item.line_total, invoice.currency, invoice.exchange_rate),
    defaultDimensions
  )

  // Debit: Expense accounts (in SEK). A bucket that nets below zero (rabatt
  // row, öresavrundning on 3740) books as a credit of the absolute value:
  // every line carries exactly one non-negative side (debitNatural).
  const debitLines: CreateJournalEntryLineInput[] = []
  for (const bucket of expenseBuckets) {
    debitLines.push({
      account_number: bucket.account,
      ...debitNatural(bucket.amount),
      line_description: desc,
      dimensions: bucket.dimensions,
    })
  }
  lines.push(...debitLines)

  const isReverseCharge = (supplierType === 'eu_business' || supplierType === 'non_eu_business' || supplierType === 'swedish_business') && invoice.reverse_charge

  if (isReverseCharge) {
    // Reverse charge: fiktiv moms entries per rate group
    // Domestic (byggtjänster etc.): 2647/26x4, EU/non-EU: 2645/26x4
    //
    // Also generate basbeloppsrader on 44xx/45xx + motkonto 4598 so SKV's
    // momsdeklaration ruta 20-24 reflects the underlying purchase amount.
    // Without these the fiktiv moms (2614/2624/2634) populates ruta 30-32
    // but ruta 20-24 stay at 0, which Skatteverket rejects with felkod
    // FK004 ("silent netting prohibited"; ML 13 kap kräver båda sidor).
    //
    // The basis-account check is done per item, on the account its net is
    // booked on (groupReverseChargeByRate): an item on an account that reports
    // ruta 20-24 itself (a 44xx/45xx basis account, or one whose momskod in
    // the kontoplan is a reverse-charge purchase) already populates ruta 20-24
    // via the expense line, so it takes no basbeloppsrader and is
    // self-assessed at that account's momssats; only the rest of a rate's base
    // gets them. Mixed invoices (4535 + 6540 at 25%) used to skip basis lines
    // entirely under a per-invoice flag, leaving ruta 30 larger than ruta 21
    // by the 6540 portion, the exact FK004 pattern.
    //
    // Drive iteration off the basis (line_total per rate), not stored
    // vat_amount: fiktiv moms is always statutory base × rate. This keeps
    // RC immune to per-line manual VAT overrides (which only make sense for
    // domestic deductible-VAT adjustments).
    const chart = await fetchChartVatTreatments(supabase, companyId)
    const rcByRate = groupReverseChargeByRate(
      items, chart, (item) => resolveBookingAccount('expense', item, item.account_number),
      invoice.currency, invoice.exchange_rate,
    )
    const rcSupplierType = supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business'
    for (const [rate, { base, basisBase }] of rcByRate) {
      if (rate > 0 && base > 0) {
        const rcLines = generateReverseChargePurchaseLines({
          base,
          rate,
          kind: reverseChargeKindForSupplierType(rcSupplierType),
          basisBase,
        })
        lines.push(...rcLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
      }
    }
  } else if (itemsHaveVat(items, invoice.vat_treatment)) {
    // Domestic standard: Debit ingående moms per rate group
    const vatByRate = groupVatByRate(items, invoice.currency, invoice.exchange_rate, invoice.vat_treatment)
    for (const [rate, amount] of vatByRate) {
      if (amount > 0) {
        lines.push({
          account_number: '2641',
          debit_amount: Math.round(amount * 100) / 100,
          credit_amount: 0,
          line_description: `Ingående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
      }
    }
  }

  // Särskild löneskatt på pensionskostnader (SLP, 24.26 %): items flagged
  // apply_slp (tjänstepensionspremier on 741x) get a self-balancing
  // 7533 D / 2514 K pair, injected the same way the reverse-charge pairs are.
  // The pair nets to zero, so the callers' 2440 balance guarantee keeps the
  // payable at the invoice total: SLP is the buyer's own tax, never part of
  // the supplier's fordran.
  const slpBase = slpBaseSek(items, invoice.currency, invoice.exchange_rate)
  if (slpBase > 0) {
    const slpLines = generateSlpLines(slpBase)
    lines.push(...slpLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
  }

  return lines
}

export interface SupplierInvoicePaymentLinesOptions {
  /**
   * SEK cleared off 2440: at the booked rate when there is a kursdifferens;
   * with `sekClearingDebt`, the SEK that left the bank for the invoice, net
   * of any fee. Always SEK, never the invoice's currency: the manual doors
   * resolve it with resolveSupplierPaymentSek (#2955).
   */
  paymentAmount: number
  /** Kursvinst (> 0) or kursförlust (< 0) in SEK; omit for none. */
  exchangeRateDifference?: number
  supplierName?: string
  /** Account credited; DEFAULT_SUPPLIER_PAYMENT_ACCOUNT when omitted. */
  paymentAccount?: string
  /** Bank fee on top of the invoice (splitSupplierBankFee), booked on 6570. */
  bankFeeSek?: number
  /**
   * Pure-SEK bank match: the SEK debt this payment clears off 2440 (the
   * invoice's remaining). There is no kursdifferens in SEK, so
   * exchangeRateDifference must be omitted.
   */
  sekClearingDebt?: number
}

export interface SupplierInvoicePaymentLines {
  description: string
  /** The payment account the bank leg credits. */
  creditAccount: string
  lines: CreateJournalEntryLineInput[]
  /** The öresavrundning booked on 3740 (SEK clearing only); 0 for none. */
  oreDiffSek: number
}

/**
 * The verifikat of a supplier payment under faktureringsmetoden, pure:
 * createSupplierInvoicePaymentEntry books exactly these lines and the payment
 * previews show them, so the rows a user approves or edits carry what gets
 * booked, the invoice's dimensions on every leg included.
 *
 *   Debit  2440 Leverantörsskulder   [payment amount]
 *   Credit 1930 Företagskonto        [payment amount]
 *
 * With exchange rate difference:
 *   Debit  2440 Leverantörsskulder   [original SEK amount]
 *   Credit 1930 Företagskonto        [actual SEK paid]
 *   Credit/Debit 3960/7960           [difference]
 *
 * SEK clearing of a matched bank row (`sekClearingDebt`): the lines come from
 * buildSupplierPaymentClearingLines, so a sub-krona difference between the
 * debt and the bank amount is booked on 3740 and 2440 clears in full.
 */
export function buildSupplierInvoicePaymentLines(
  invoice: Pick<SupplierInvoice, 'supplier_invoice_number' | 'arrival_number' | 'default_dimensions'>,
  options: SupplierInvoicePaymentLinesOptions,
): SupplierInvoicePaymentLines {
  const { paymentAmount, exchangeRateDifference, supplierName, bankFeeSek, sekClearingDebt } = options
  if (sekClearingDebt !== undefined && exchangeRateDifference) {
    throw new Error('buildSupplierInvoicePaymentLines: a SEK clearing has no exchange rate difference')
  }
  const creditAccount = options.paymentAccount || DEFAULT_SUPPLIER_PAYMENT_ACCOUNT

  const desc = buildSupplierDescription('Utbetalning leverantörsfaktura', invoice.supplier_invoice_number, supplierName, `(ankomstnr ${invoice.arrival_number})`)
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: the payment voucher re-propagates the linked invoice's
  // default bag onto every leg (incl. FX result lines), see the stamp below.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)
  let oreDiffSek = 0

  if (sekClearingDebt !== undefined) {
    // Matched SEK bank row: 3740 öresavrundning and the 6570 bank fee included.
    const clearing = buildSupplierPaymentClearingLines({
      apSek: sekClearingDebt,
      bankSek: paymentAmount,
      paymentAccount: creditAccount,
      bankFeeSek,
    })
    lines.push(...clearing.lines)
    oreDiffSek = clearing.oreDiffSek
  } else if (exchangeRateDifference && exchangeRateDifference !== 0) {
    // Foreign currency with exchange rate difference
    const originalSekAmount = paymentAmount
    const actualSekPaid = paymentAmount - exchangeRateDifference

    // Debit: Clear leverantörsskulder at original booked SEK amount
    lines.push({
      account_number: '2440',
      debit_amount: Math.round(originalSekAmount * 100) / 100,
      credit_amount: 0,
      line_description: desc,
    })

    // Credit: Bank at actual SEK paid
    lines.push({
      account_number: creditAccount,
      debit_amount: 0,
      credit_amount: Math.round(actualSekPaid * 100) / 100,
      line_description: desc,
    })

    // Exchange rate difference: paid less than booked is a gain (Cr 3960),
    // more a loss (Dr 7960).
    lines.push(fxDifferenceLine(exchangeRateDifference))
  } else {
    // Standard SEK payment
    lines.push({
      account_number: '2440',
      debit_amount: Math.round(paymentAmount * 100) / 100,
      credit_amount: 0,
      line_description: desc,
    })

    lines.push({
      account_number: creditAccount,
      debit_amount: 0,
      credit_amount: Math.round(paymentAmount * 100) / 100,
      line_description: desc,
    })
  }
  // The clearing builder above books the fee itself.
  if (sekClearingDebt === undefined) addSupplierBankFeeLine(lines, creditAccount, bankFeeSek)

  if (defaultDimensions) {
    // Copy per line: a shared bag object would let one line's mutation
    // leak into every other line (same contract as proposal stamping).
    for (const line of lines) line.dimensions = { ...defaultDimensions }
  }

  return { description: desc, creditAccount, lines, oreDiffSek }
}

/**
 * Create the journal entry when a supplier invoice is paid (accrual method):
 * the lines of buildSupplierInvoicePaymentLines, booked in the open period of
 * the payment date. Returns null when no open period covers it.
 */
export async function createSupplierInvoicePaymentEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  // SEK, see SupplierInvoicePaymentLinesOptions.paymentAmount.
  paymentAmount: number,
  paymentDate: string,
  exchangeRateDifference?: number,
  supplierName?: string,
  paymentAccount?: string,
  bankTransaction?: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>,
  // Bank fee on top of the invoice (splitSupplierBankFee), booked on 6570.
  bankFeeSek?: number,
  // Pure-SEK bank match: see SupplierInvoicePaymentLinesOptions.sekClearingDebt.
  sekClearingDebt?: number,
): Promise<JournalEntry | null> {
  const { description, creditAccount, lines } = buildSupplierInvoicePaymentLines(invoice, {
    paymentAmount,
    exchangeRateDifference,
    supplierName,
    paymentAccount,
    bankFeeSek,
    sekClearingDebt,
  })
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description,
    source_type: 'supplier_invoice_paid',
    source_id: invoice.id,
    ...(bankTransaction ? { bank_booking_context: [bankBookingContext(bankTransaction, creditAccount)] } : {}),
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

export interface SupplierInvoiceCashLinesOptions {
  supplierName?: string
  /** Payment account credited; defaults to DEFAULT_SUPPLIER_PAYMENT_ACCOUNT. */
  paymentAccount?: string
  /**
   * SEK that actually left the bank, when the payment is matched from a bank
   * row. For a foreign-currency invoice this pins the whole entry to the
   * PAYMENT-date rate, see the kontantmetoden note below. For a SEK invoice a
   * sub-krona difference to the debt is booked on 3740 (öresavrundning). Omit
   * on the mark-paid doors, where no bank row is known: a SEK invoice with
   * display-only öresavrundning then settles at the whole-krona amount the
   * user was told to pay.
   */
  settledBankSek?: number
  /** Bank fee on top of the invoice (splitSupplierBankFee), booked on 6570. */
  bankFeeSek?: number
  /**
   * The company's momskoder (fetchChartVatTreatments), required for a
   * reverse-charge invoice (the builder throws without them): an item on an
   * account that reports ruta 20-24 itself gets no basis pair and is
   * self-assessed at that account's momssats. Unread otherwise.
   */
  chartVatTreatments?: ChartVatTreatments
}

export interface SupplierInvoiceCashLinesResult {
  /** Verifikat header text, also stamped on the expense and payment legs. */
  description: string
  lines: CreateJournalEntryLineInput[]
  /** The payment-account credit in SEK. */
  bankSek: number
  /** Öre residual booked on 3740: >0 credit (vinst), <0 debit (förlust), 0 none. */
  oreDiffSek: number
}

/**
 * The lines of the kontantmetoden payment verifikat. Pure: no DB calls.
 *
 * Single source of truth for createSupplierInvoiceCashEntry (every commit
 * door: dashboard and v1 mark-paid, dashboard and v1 match-supplier-invoice)
 * AND both previews (mark-paid/preview, match-supplier-invoice/preview), so
 * what the user approves is what gets booked. The previews used to re-model
 * the entry by hand and had drifted from it.
 *
 * Throws SupplierInvoiceFxRateMissingError (toSekOrThrow) for a foreign
 * invoice with no usable rate.
 */
export function buildSupplierInvoiceCashLines(
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  options: SupplierInvoiceCashLinesOptions = {},
): SupplierInvoiceCashLinesResult {
  const { supplierName, paymentAccount, settledBankSek, bankFeeSek, chartVatTreatments } = options
  const creditAccount = paymentAccount || DEFAULT_SUPPLIER_PAYMENT_ACCOUNT

  // Under kontantmetoden the booked affärshändelse IS the payment (BFL 5 kap:
  // "bokföring vid betalningstillfället"), so the entire verifikat is translated
  // at the PAYMENT-date rate (ÅRL 4 kap 6 §). There is no kursvinst/kursförlust
  // because no leverantörsskuld was ever carried at a historical rate: that
  // only happens under faktureringsmetoden (handled by the 2440-clearing path
  // with 7960/3960). When the caller passes the SEK that actually settled the
  // invoice, we derive the implied payment-date rate from it so the payment-
  // account credit equals the bank movement to the öre. For SEK invoices, or
  // when no settlement SEK is supplied, we keep the invoice's stored rate.
  const isForeign = invoice.currency !== 'SEK'
  const useSettlementRate =
    settledBankSek != null && settledBankSek > 0 && isForeign && invoice.total > 0
  const effectiveRate = useSettlementRate
    ? settledBankSek / invoice.total
    : invoice.exchange_rate

  // A number-less invoice is named by its ankomstnummer, so the verifikat
  // still identifies which invoice it pays (BFL 5 kap 7 §).
  const desc = buildSupplierDescription(
    'Kontantbetalning leverantörsfaktura',
    supplierInvoiceReference(invoice.supplier_invoice_number, invoice.arrival_number),
    supplierName,
  )
  const lines: CreateJournalEntryLineInput[] = []
  // Dimensions PR7: kontantmetoden books the expense at payment, same merge
  // rules as the registration entry.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)
  // Expense debit lines tracked separately so a sub-öre translation residual
  // can be folded into the largest one (öresavrundning step below).
  const expenseLines: CreateJournalEntryLineInput[] = []

  // Aggregate expense amounts by (account, dimensions) and convert to SEK
  const expenseBuckets = groupExpenseBuckets(
    items,
    (item) => item.account_number,
    (item) => toSekOrThrow(item.line_total, invoice.currency, effectiveRate),
    defaultDimensions
  )

  // Debit: Expense accounts (in SEK). Negative buckets flip to the credit
  // side (debitNatural), same rule as the registration entry.
  for (const bucket of expenseBuckets) {
    const line: CreateJournalEntryLineInput = {
      account_number: bucket.account,
      ...debitNatural(bucket.amount),
      line_description: desc,
      dimensions: bucket.dimensions,
    }
    lines.push(line)
    expenseLines.push(line)
  }

  const isReverseCharge = (supplierType === 'eu_business' || supplierType === 'non_eu_business' || supplierType === 'swedish_business') && invoice.reverse_charge

  if (isReverseCharge) {
    // Reverse charge: fiktiv moms entries per rate group
    // Domestic (byggtjänster etc.): 2647/26x4, EU/non-EU: 2645/26x4
    //
    // Also generate basbeloppsrader on 44xx/45xx + motkonto 4598 so SKV's
    // momsdeklaration ruta 20-24 reflects the underlying purchase amount.
    // Without these the fiktiv moms (2614/2624/2634) populates ruta 30-32
    // but ruta 20-24 stay at 0, which Skatteverket rejects with felkod
    // FK004 ("silent netting prohibited"; ML 13 kap kräver båda sidor).
    // Per-rate bucketing: see registration entry above for the FK004 rationale.
    // Drive iteration off the basis (line_total per rate): fiktiv moms is
    // always statutory base × rate; manual vat_amount overrides don't apply.
    // effectiveRate (payment-date rate under kontantmetoden) keeps the fiktiv
    // moms base consistent with the expense lines above.
    // No answer without the chart (costAccountRcBasisRate): read as "no
    // momskod", it would put a basis pair beside an account that reports
    // ruta 20-24 itself (crm#1096).
    if (!chartVatTreatments) {
      throw new Error('buildSupplierInvoiceCashLines: a reverse-charge invoice needs the company momskoder (fetchChartVatTreatments)')
    }
    const rcByRate = groupReverseChargeByRate(
      items, chartVatTreatments, (item) => item.account_number, invoice.currency, effectiveRate,
    )
    const rcSupplierType = supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business'
    for (const [rate, { base, basisBase }] of rcByRate) {
      if (rate > 0 && base > 0) {
        const rcLines = generateReverseChargePurchaseLines({
          base,
          rate,
          kind: reverseChargeKindForSupplierType(rcSupplierType),
          basisBase,
        })
        lines.push(...rcLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
      }
    }
  } else if (itemsHaveVat(items, invoice.vat_treatment)) {
    // Domestic standard: Debit ingående moms per rate group (at the payment-
    // date rate when settling a foreign invoice, see effectiveRate above).
    const vatByRate = groupVatByRate(items, invoice.currency, effectiveRate, invoice.vat_treatment)
    for (const [rate, amount] of vatByRate) {
      if (amount > 0) {
        lines.push({
          account_number: '2641',
          debit_amount: Math.round(amount * 100) / 100,
          credit_amount: 0,
          line_description: `Ingående moms ${Math.round(rate * 100)}% ${desc}`,
          dimensions: defaultDimensions,
        })
      }
    }
  }

  // Särskild löneskatt på pensionskostnader (SLP): same self-balancing
  // 7533 D / 2514 K pair as the registration entry, at the effective rate so
  // the base stays consistent with the expense lines above. Nets to zero:
  // the payment-account credit below is untouched.
  const slpBase = slpBaseSek(items, invoice.currency, effectiveRate)
  if (slpBase > 0) {
    const slpLines = generateSlpLines(slpBase)
    lines.push(...slpLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
  }

  // Öresavrundning: when translating a foreign invoice at the payment-date
  // rate, per-line rounding can drift the implied bank total by an öre or two.
  // Fold that residual into the largest expense line so the payment-account
  // credit lands exactly on the SEK that left the bank (1930 reconciles to the
  // bank transaction). Immaterial to the momsdeklaration: rutor are whole
  // kronor. The |residual| ≤ 1 guard ensures we only absorb rounding noise,
  // never a real shortfall (a partial settlement is blocked upstream).
  if (useSettlementRate && expenseLines.length > 0) {
    const debitSum = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const creditSum = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    const provisionalCredit = roundOre(debitSum - creditSum)
    const residual = roundOre(settledBankSek! - provisionalCredit)
    if (residual !== 0 && Math.abs(residual) <= 1) {
      const target = expenseLines.reduce((a, b) => (b.debit_amount >= a.debit_amount ? b : a))
      target.debit_amount = roundOre(target.debit_amount + residual)
    }
  }

  // Credit: payment account, balance guarantee: ensures sum(debits) === sum(credits)
  // For reverse charge, intermediate credits (2614/2624/2634) already exist, so we subtract them
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)

  // Öresavrundning (#2852): the payment account must carry what actually
  // left the bank, not the exact öre debt, or 1930 drifts from the bank row
  // by up to 50 öre per invoice. The residual goes to 3740 (no VAT), decided
  // by the same rule as the accrual clearing path. Kontantmetoden books the
  // affärshändelse at payment, and the generated cash entry only ever settles
  // an invoice in full from a fully unpaid state (cashPartialBlockReason), so
  // the residual always belongs to this one settling verifikat. Foreign
  // invoices are untouched: their bank leg is pinned by the settlement rate.
  const settlement = resolveSupplierCashSettlement({
    invoice,
    owedSek: totalDebits - totalCredits,
    knownBankSek: isForeign ? undefined : settledBankSek,
  })
  lines.push({
    account_number: creditAccount,
    ...creditNatural(settlement.oreDiffSek !== 0 ? settlement.bankSek : totalDebits - totalCredits),
    line_description: desc,
    dimensions: defaultDimensions,
  })
  if (settlement.oreDiffSek !== 0) {
    lines.push({
      ...supplierOreRoundingLine(settlement.oreDiffSek),
      dimensions: defaultDimensions,
    })
  }
  // The fee is part of this invoice's payment: it carries the same bag.
  addSupplierBankFeeLine(lines, creditAccount, bankFeeSek, defaultDimensions)

  return {
    description: desc,
    lines,
    bankSek: settlement.bankSek,
    oreDiffSek: settlement.oreDiffSek,
  }
}

/**
 * Create journal entry for cash method (kontantmetoden)
 * Combined entry at payment time:
 *
 *   Debit  5xxx/6xxx (per item)      [line_total]
 *   Debit  2641 Ingående moms        [total VAT]
 *   Credit 1930 Företagskonto        [what left the bank]
 *   Cr/Dr  3740 Öresavrundning       [sub-krona residual, when there is one]
 *
 * Lines come from buildSupplierInvoiceCashLines, shared with the previews.
 */
export async function createSupplierInvoiceCashEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: SupplierInvoice,
  items: SupplierInvoiceItem[],
  paymentDate: string,
  supplierType: string,
  supplierName?: string,
  paymentAccount?: string,
  // SEK that actually settled the invoice (the amount that left the bank),
  // see SupplierInvoiceCashLinesOptions.settledBankSek.
  settledBankSek?: number,
  bankTransaction?: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>,
  bankFeeSek?: number,
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  const { description, lines } = buildSupplierInvoiceCashLines(invoice, items, supplierType, {
    supplierName,
    paymentAccount,
    settledBankSek,
    bankFeeSek,
    chartVatTreatments: invoice.reverse_charge ? await fetchChartVatTreatments(supabase, companyId) : undefined,
  })

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description,
    source_type: 'supplier_invoice_cash_payment',
    source_id: invoice.id,
    ...(bankTransaction ? { bank_booking_context: [bankBookingContext(bankTransaction, paymentAccount || DEFAULT_SUPPLIER_PAYMENT_ACCOUNT)] } : {}),
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Kontering for a supplier invoice someone paid out of their own pocket
 * (utlägg), as custom lines for registerExpenseClaim (lib/expenses). The AP
 * leg is bypassed entirely: instead of crediting 2440 and later debiting it on
 * mark-paid, the invoice's lines book straight against the person's liability
 * account:
 *
 *   Debit  5xxx/6xxx (per account + dimensions)   [line_total]
 *   Debit  2641 Ingående moms                     [VAT per rate]
 *   Credit 2893 / 2018 / 2820                     [total incl VAT]
 *
 * Amounts stay in the invoice currency: the claims service converts every
 * line at the claim rate and keeps the liability credit equal to the claim
 * total to the öre, which is what the payout flow later reimburses. That is
 * why this is a pure builder and not a second entry generator: the verifikat
 * and the expense_claims row come from the same writer as the Underlag pane.
 *
 * Reverse charge is intentionally not supported here. RC invoices are never
 * "I paid this at a kiosk" cases: they're EU/byggtjänster from registered
 * businesses with formal invoices, which always go through AP. The route
 * guards against this combo before calling us.
 */
export function buildSupplierInvoicePrivatelyPaidLines(
  invoice: Pick<SupplierInvoice, 'default_dimensions' | 'vat_treatment'>,
  items: SupplierInvoiceItem[],
  liabilityAccount: string,
  description: string
): ExpenseClaimLineInput[] {
  const lines: ExpenseClaimLineInput[] = []
  // Dimensions PR7: this IS the utlägg path, billable-expense-to-project
  // tagging rides the same merge rules as the registration entry.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Debit: expense accounts, aggregated per (account, dimensions). A bucket
  // that nets below zero (discount rows) becomes a credit so every line keeps
  // exactly one side; an empty bucket is dropped.
  const expenseBuckets = groupExpenseBuckets(
    items,
    (item) => item.account_number,
    (item) => item.line_total ?? 0,
    defaultDimensions
  )
  for (const bucket of expenseBuckets) {
    const amount = roundOre(bucket.amount)
    if (amount === 0) continue
    lines.push({
      account_number: bucket.account,
      ...debitNatural(amount),
      line_description: description,
      dimensions: bucket.dimensions,
    })
  }

  // Debit: Ingående moms per rate group (mixed-rate kvitto support). Same
  // per-item rule as groupVatByRate, without the SEK conversion: a stored
  // override wins over the computed line_total x rate. Gated on the same
  // vat_treatment contract as the AP paths: an exempt or export kvitto has
  // no moms to lift off, so its gross belongs on the cost account.
  if (itemsHaveVat(items, invoice.vat_treatment)) {
    const vatByRate = new Map<number, number>()
    for (const item of items) {
      const rate = item.vat_rate ?? 0.25
      const storedVat = item.vat_amount ?? 0
      const computedVat = rate > 0 ? roundOre((item.line_total ?? 0) * rate) : 0
      const vat = storedVat > 0 ? storedVat : computedVat
      vatByRate.set(rate, (vatByRate.get(rate) || 0) + vat)
    }
    for (const [rate, amount] of vatByRate) {
      const vat = roundOre(amount)
      if (vat > 0) {
        lines.push({
          account_number: '2641',
          debit_amount: vat,
          credit_amount: 0,
          line_description: `Ingående moms ${Math.round(rate * 100)}% ${description}`,
          dimensions: defaultDimensions,
        })
      }
    }
  }

  // Särskild löneskatt på pensionskostnader (SLP): same self-balancing
  // 7533 D / 2514 K pair as the registration entry. Nets to zero, so the
  // liability account below still carries exactly the expense + VAT total.
  // generateSlpLines is pure arithmetic, so the invoice-currency base is fine.
  let slpBase = 0
  for (const item of items) {
    if (item.apply_slp === true && isSlpPensionAccount(item.account_number)) {
      slpBase += item.line_total ?? 0
    }
  }
  if (slpBase > 0) {
    for (const l of generateSlpLines(slpBase)) {
      lines.push({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        line_description: l.line_description,
        dimensions: defaultDimensions,
      })
    }
  }

  // Credit: the person's liability, balance guarantee. Existing credits (the
  // SLP 2514 leg, a discount bucket) are subtracted so the pair never inflates
  // what the person is owed: same guarantee shape as the registration entry's
  // 2440 line.
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  lines.push({
    account_number: liabilityAccount,
    ...creditNatural(totalDebits - totalCredits),
    line_description: description,
    dimensions: defaultDimensions,
  })

  return lines
}

/**
 * The account expense_claims.expense_account records for a supplier invoice
 * paid privately: the largest cost line's. The column holds one account (the
 * Underlag pane books one receipt to one account); the full breakdown lives
 * on the verifikat lines. First line wins a tie.
 */
export function largestExpenseAccount(items: SupplierInvoiceItem[]): string {
  let best: SupplierInvoiceItem | null = null
  for (const item of items) {
    if (!best || Math.abs(item.line_total ?? 0) > Math.abs(best.line_total ?? 0)) best = item
  }
  return best?.account_number ?? ''
}

/**
 * Create the journal entry for a supplier credit note: the original's
 * registration turned around.
 *
 *   Debit  2440 Leverantörsskulder            [what the registration credited]
 *   Credit 5xxx/6xxx (per account, dimensions) [line_total]
 *   Credit 2641 Ingående moms (per rate)       [VAT per rate]
 *
 * Every line is one buildSupplierInvoiceRowLines books for the same rows,
 * on the other side: the cost lines, the ingående moms, the reverse-charge
 * sets (2645/2647 and 26x4, 44xx/45xx and 4598, so rutor 20-24, 30-32 and 48
 * fall back by what the registration put in them) and the SLP pair. A row the
 * original books as a credit (a rabatt, an öresavrundning downwards, the
 * output side of a reverse charge stored as a row) is debited here, so the
 * original and a full credit note net to zero on every account and dimension
 * cell, 2440 included. Taking each line's absolute value instead credited
 * such a row a second time and debited 2440 by more than the original
 * credited.
 *
 * `items` are the ORIGINAL invoice's rows, signed as the original books them:
 * deferred lines then reverse against the 17xx interim account they were
 * registered on (the schedule's posted dissolutions are stornoed separately by
 * cancelSchedulesForSource), and the item bags against the same dimension
 * cells, while the credit note's own default_dimensions (copied from the
 * original at credit time) ride the 2440, moms and reverse-charge lines.
 * Scaled-down rows reverse a part the same way, each row on its own side.
 *
 * `invoicePayableSek` is what the original owes in SEK (its total_sek). When
 * given, the lines must move 244x by it, the original's own 244x rows
 * included, to within creditNotePayableToleranceSek; otherwise
 * SupplierCreditNoteRowsMismatchError is thrown and nothing is posted
 * (buildSupplierCreditNoteLines, which creditSupplierInvoice also asks before
 * it writes anything: assertSupplierCreditNoteRowsMatchPayable).
 */
export async function createSupplierCreditNoteEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  creditNote: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  supplierName?: string,
  invoicePayableSek?: number | null,
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, creditNote.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for credit note date:', creditNote.invoice_date)
    return null
  }

  const desc = buildSupplierDescription('Kreditfaktura leverantör', creditNote.supplier_invoice_number, supplierName, `(ankomstnr ${creditNote.arrival_number})`)
  const lines = await buildSupplierCreditNoteLines(
    supabase, companyId, creditNote, items, supplierType, desc, invoicePayableSek,
  )

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: creditNote.invoice_date,
    description: desc,
    source_type: 'supplier_credit_note',
    source_id: creditNote.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * The rule createSupplierCreditNoteEntry holds a credit note to, asked before
 * there is a credit note: resolves when the reversal of `items` moves 244x by
 * `invoicePayableSek`, throws SupplierCreditNoteRowsMismatchError when it
 * does not. The same lines and the same comparison as the posting path
 * (buildSupplierCreditNoteLines), so the two cannot disagree; nothing is
 * posted or written. `original` is the invoice to be credited.
 */
export async function assertSupplierCreditNoteRowsMatchPayable(
  supabase: SupabaseClient,
  companyId: string,
  original: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  invoicePayableSek: number | null,
): Promise<void> {
  await buildSupplierCreditNoteLines(supabase, companyId, original, items, supplierType, '', invoicePayableSek)
}

/**
 * The lines of a supplier credit note's verifikat, with the payable rule
 * applied: every line buildSupplierInvoiceRowLines books for `items` on the
 * other side, and 2440 by their balance. Posts nothing; the company's
 * momskoder are read only for a reverse-charge invoice.
 *
 * `header` is the credit note, or the original it is copied from
 * (buildSupplierCreditNoteRow): currency, rate, moms treatment and dimension
 * bag are the same on both, so the amounts are too.
 */
async function buildSupplierCreditNoteLines(
  supabase: SupabaseClient,
  companyId: string,
  header: SupplierInvoice,
  items: SupplierInvoiceItem[],
  supplierType: string,
  desc: string,
  invoicePayableSek?: number | null,
): Promise<CreateJournalEntryLineInput[]> {
  const lines = (await buildSupplierInvoiceRowLines(supabase, companyId, header, items, supplierType, desc))
    .map((line) => ({ ...line, debit_amount: line.credit_amount, credit_amount: line.debit_amount }))

  // Debit: Leverantörsskulder, balance guarantee: what the registration
  // credited. An original whose rows net below zero was booked with 2440 on
  // the debit side, so its credit note credits it. Rows that carry the skuld
  // themselves (a 244x row) net to zero and need no skuld line of 0.
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  if (roundOre(totalCredits - totalDebits) !== 0) {
    lines.unshift({
      account_number: '2440',
      ...debitNatural(totalCredits - totalDebits),
      line_description: desc,
      dimensions: coerceDimensionsBag(header.default_dimensions),
    })
  }

  if (typeof invoicePayableSek === 'number' && Number.isFinite(invoicePayableSek)) {
    const rowsPayableSek = roundOre(lines
      .filter((l) => l.account_number.startsWith('244'))
      .reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0))
    const gapSek = Math.abs(roundOre(rowsPayableSek - invoicePayableSek))
    if (gapSek > creditNotePayableToleranceSek(header, items.length)) {
      throw new SupplierCreditNoteRowsMismatchError(rowsPayableSek, roundOre(invoicePayableSek))
    }
  }

  return lines
}

/**
 * Group items by VAT rate and sum the stored VAT amount per rate.
 * Returns a Map<rate, totalVatAmount> in SEK for per-rate 2641 journal lines.
 *
 * Reads `item.vat_amount` directly: set by the API from the line's manual
 * override when present, else computed line_total × rate. This is the path
 * for partial-deductible cases (bilförmån 50%, representation 300 kr-tak),
 * foreign-currency rounding, and supplier POS rounding.
 *
 * Fallback to line_total × rate when vat_amount is null/0 but rate > 0:
 * legacy import paths (SIE, CSV, demo seed) sometimes leave vat_amount at
 * the column DEFAULT of 0. Silently dropping input VAT to 2641 would
 * understate ruta 48 in the momsdeklaration.
 *
 * Reverse-charge fiktiv moms doesn't use this: see groupReverseChargeByRate,
 * which derives the basis directly so fiktiv VAT is always base × statutory rate.
 */
/**
 * True if any item would produce a non-zero ingående moms line: mirrors the
 * same stored-vs-computed fallback groupVatByRate uses (stored vat_amount,
 * else line_total × rate). Callers must gate the VAT branch on this instead
 * of invoice.vat_amount: that header field can come from a source (e.g. the
 * MCP inbox-conversion tool's OCR-extracted totals) that is never
 * reconciled against the items, so a stale or zero header would otherwise
 * silently suppress a correct per-line VAT posting.
 *
 * The invoice's vat_treatment is a required argument, not an optional one:
 * under `exempt` or `export` the supplier charged no Swedish moms at all, so
 * no 2641 line may be emitted whatever the stored rates say (issue #2553).
 * The rate cannot answer that on its own, because supplier_invoice_items
 * .vat_rate defaults to 0.25 in the database and every create path used to
 * fill an omitted rate with 25 %.
 */
function itemsHaveVat(
  items: SupplierInvoiceItem[],
  vatTreatment: string | null | undefined
): boolean {
  if (!treatmentDeductsInputVat(vatTreatment)) return false
  return items.some((item) => {
    if ((item.vat_amount ?? 0) > 0) return true
    const rate = item.vat_rate ?? 0.25
    return rate > 0 && (item.line_total ?? 0) > 0
  })
}

function groupVatByRate(
  items: SupplierInvoiceItem[],
  currency: string,
  exchangeRate: number | null,
  vatTreatment: string | null | undefined,
): Map<number, number> {
  const vatByRate = new Map<number, number>()
  // Second gate on the same contract as itemsHaveVat, which every caller
  // checks first: a stale stored 0.25 must never resurrect 2641.
  if (!treatmentDeductsInputVat(vatTreatment)) return vatByRate
  for (const item of items) {
    const rate = item.vat_rate ?? 0.25
    const storedVat = item.vat_amount ?? 0
    const computedVat = rate > 0
      ? Math.round((item.line_total ?? 0) * rate * 100) / 100
      : 0
    const sourceVat = storedVat > 0 ? storedVat : computedVat
    const vatSek = toSekOrThrow(sourceVat, currency, exchangeRate)
    vatByRate.set(rate, (vatByRate.get(rate) || 0) + vatSek)
  }
  return vatByRate
}

/**
 * Group items by their self-assessed reverse-charge rate and sum, per rate,
 * the base (line_total in SEK) and the part of it that needs the basis pair.
 * Used by reverse-charge paths to compute fiktiv moms from the basis,
 * decoupled from any manual VAT override on the items.
 *
 * Each item is assessed on the account its net is booked on (`bookedAccount`:
 * a periodiserad line sits on its 17xx interim account, which reports
 * nothing) by reverseChargeOnAccount with the company's momskoder (crm#1096).
 * An item on an account that reports ruta 20-24 itself (a 44xx/45xx basis
 * account, or a class 4-6 account whose momskod in the kontoplan is a
 * reverse-charge purchase) populates ruta 20-24 directly via the expense
 * line, so it takes no basis pair (that would count it twice) and is
 * self-assessed at that account's momssats, where the declaration buckets its
 * basis. Any other item keys on its *self-assessed* rate
 * (resolveReverseChargeRate), not the line's vat_rate: under omvänd
 * skattskyldighet the supplier charges 0%, so the line vat_rate is 0, but the
 * buyer self-assesses at 25% (huvudregeln) or the explicit per-item
 * reverse_charge_rate. Without this a 0%-rate RC line would key on rate 0 and
 * the `rate > 0` guard of the callers would skip its VAT lines.
 */
function groupReverseChargeByRate(
  items: SupplierInvoiceItem[],
  chart: ChartVatTreatments,
  bookedAccount: (item: SupplierInvoiceItem) => string,
  currency: string,
  exchangeRate: number | null,
): Map<number, { base: number; basisBase: number }> {
  const byRate = new Map<number, { base: number; basisBase: number }>()
  for (const item of items) {
    if (isSupplierInvoiceRoundingItem(item, item.line_total, currency)) continue
    const { rate, basisPair } = reverseChargeOnAccount(bookedAccount(item), resolveReverseChargeRate(item), chart)
    const baseSek = toSekOrThrow(item.line_total, currency, exchangeRate)
    const group = byRate.get(rate) ?? { base: 0, basisBase: 0 }
    group.base += baseSek
    if (basisPair) group.basisBase += baseSek
    byRate.set(rate, group)
  }
  return byRate
}

/**
 * Sum, in SEK, the base for särskild löneskatt på pensionskostnader: items
 * flagged apply_slp whose account is a 741x pension-premium account
 * (tjänstepensionspremier). The create routes reject apply_slp on any other
 * account; the account check here is defense in depth so a tampered or
 * legacy row can never SLP-flag an arbitrary expense.
 */
function slpBaseSek(
  items: SupplierInvoiceItem[],
  currency: string,
  exchangeRate: number | null | undefined,
): number {
  let base = 0
  for (const item of items) {
    if (item.apply_slp !== true) continue
    if (!isSlpPensionAccount(item.account_number)) continue
    base += toSekOrThrow(item.line_total, currency, exchangeRate)
  }
  return base
}
