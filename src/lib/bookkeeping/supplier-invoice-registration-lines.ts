/**
 * The lines a supplier invoice's registration verifikat books, as pure data.
 *
 * createSupplierInvoiceRegistrationEntry (supplier-invoice-entries.ts) posts
 * exactly supplierInvoiceRegistrationLines, and the "Granska
 * leverantörsfaktura" review dialog previews the same function before the
 * invoice exists. The dialog is a client component, so this module carries
 * no database, engine or server dependency: the company's momskoder (the
 * only thing a reverse charge reads from the database) come in as an
 * argument. The dialog used to keep a hand-written copy of these rules; it
 * dropped the ingående moms of every row below zero (a rabatt row) before
 * summing per rate, so its 2641 and its balance disagreed with the verifikat
 * actually posted (crm#1190).
 *
 * The kontantmetoden and utlägg builders in supplier-invoice-entries.ts use
 * the same grouping helpers, so all three book ingående moms by one rule.
 */
import { resolveSekAmount, buildCurrencyMetadata } from './currency-utils'
import { resolveBookingAccount } from './accruals/account-suggestions'
import {
  generateReverseChargePurchaseLines,
  resolveReverseChargeRate,
  reverseChargeOnAccount,
  supplierInvoiceReverseChargeKind,
  type ChartVatTreatments,
} from './vat-entries'
import { generateSlpLines, isSlpPensionAccount } from './slp-lines'
import { treatmentDeductsInputVat } from '@/lib/vat/supplier-invoice-line-checks'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  mergeDimensionBags,
  type LineDimensions,
} from './dimension-resolver'
import { roundOre } from '@/lib/money'
import { creditNatural, debitNatural } from './line-side'
import { isSupplierInvoiceRoundingItem } from '@/lib/bookkeeping/supplier-invoice-rounding-item'
import type { CreateJournalEntryLineInput, SupplierInvoice, SupplierInvoiceItem } from '@/types'

/**
 * Stable code for the "foreign-currency supplier invoice without a rate"
 * refusal. Registered in lib/errors/structured-errors.ts so REST routes, the
 * MCP server and getErrorMessage() all translate it the same way.
 */
export const SI_FX_RATE_MISSING = 'SI_FX_RATE_MISSING' as const

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
 * Convert an invoice-currency amount to SEK for a journal entry line.
 *
 * SEK invoices short-circuit exactly as before, and so does any invoice with a
 * legitimately supplied positive rate: the only new behaviour is the refusal
 * above when a foreign invoice reaches a booking path with no rate at all.
 * Every conversion in the supplier-invoice builders goes through here so no
 * leg (expense, moms, fiktiv moms, basbelopp, 2440) can be posted at a
 * fabricated 1:1 rate. Exported for the paths that must reproduce a posted
 * registration's SEK figures exactly (lib/supplier-invoices/item-account.ts).
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
 * The fields of a supplier invoice row the verifikat builders read. A stored
 * SupplierInvoiceItem satisfies it; the review dialog builds one from the
 * form rows the way the create paths store them.
 */
export type SupplierInvoiceBookingItem = Pick<
  SupplierInvoiceItem,
  | 'account_number'
  | 'line_total'
  | 'vat_rate'
  | 'vat_amount'
  | 'reverse_charge_rate'
  | 'accrual_period_start'
  | 'accrual_period_end'
  | 'accrual_balance_account'
  | 'dimensions'
  | 'apply_slp'
>

/** The header fields the registration verifikat reads. */
export type SupplierInvoiceRegistrationHeader = Pick<
  SupplierInvoice,
  'currency' | 'exchange_rate' | 'reverse_charge' | 'reverse_charge_kind' | 'vat_treatment' | 'default_dimensions' | 'total'
>

/**
 * Aggregate item amounts per (booking account, merged dimensions bag):
 * dimensions PR7. The merged bag (item.dimensions over the invoice's
 * default_dimensions) is part of the aggregation identity so two items on the
 * same account but different tags stay on separate journal lines instead of
 * collapsing. Insertion order is first-seen, matching the old per-account map.
 */
export interface ExpenseBucket {
  account: string
  dimensions?: LineDimensions
  amount: number
}

export function groupExpenseBuckets<T extends Pick<SupplierInvoiceBookingItem, 'dimensions'>>(
  items: T[],
  resolveAccount: (item: T) => string,
  toSek: (item: T) => number,
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
 * The ingående moms one row carries: its stored vat_amount, or line_total ×
 * rate when nothing is stored.
 *
 * The stored amount is set by the create paths from the line's manual
 * override when present, else computed line_total × rate. That is the path
 * for partial-deductible cases (bilförmån 50%, representation 300 kr-tak),
 * foreign-currency rounding, and supplier POS rounding. It carries the row's
 * sign: a rabatt row of -50,00 at 25% stores -12,50, and that -12,50 is what
 * the invoice's own moms total (and so its payable) counts.
 *
 * Fallback to line_total × rate when vat_amount is null/0 but rate > 0:
 * legacy import paths (SIE, CSV, demo seed) sometimes leave vat_amount at
 * the column DEFAULT of 0. Silently dropping input VAT to 2641 would
 * understate ruta 48 in the momsdeklaration.
 */
function rowInputVat(item: Pick<SupplierInvoiceBookingItem, 'line_total' | 'vat_rate' | 'vat_amount'>): number {
  const rate = item.vat_rate ?? 0.25
  const storedVat = item.vat_amount ?? 0
  if (storedVat !== 0) return storedVat
  return rate > 0 ? roundOre((item.line_total ?? 0) * rate) : 0
}

/**
 * True if any item would produce a non-zero ingående moms line: mirrors the
 * same stored-vs-computed fallback groupVatByRate uses (stored vat_amount,
 * else line_total × rate), whatever the row's sign. Callers must gate the VAT
 * branch on this instead of invoice.vat_amount: that header field can come
 * from a source (e.g. the MCP inbox-conversion tool's OCR-extracted totals)
 * that is never reconciled against the items, so a stale or zero header would
 * otherwise silently suppress a correct per-line VAT posting.
 *
 * The invoice's vat_treatment is a required argument, not an optional one:
 * under `exempt` or `export` the supplier charged no Swedish moms at all, so
 * no 2641 line may be emitted whatever the stored rates say (issue #2553).
 * The rate cannot answer that on its own, because supplier_invoice_items
 * .vat_rate defaults to 0.25 in the database and every create path used to
 * fill an omitted rate with 25 %.
 */
export function itemsHaveVat(
  items: Array<Pick<SupplierInvoiceBookingItem, 'line_total' | 'vat_rate' | 'vat_amount'>>,
  vatTreatment: string | null | undefined
): boolean {
  if (!treatmentDeductsInputVat(vatTreatment)) return false
  return items.some((item) => rowInputVat(item) !== 0)
}

/**
 * Group items by VAT rate and sum each row's ingående moms (rowInputVat),
 * converted by `toAmount` (SEK for the AP paths, the identity for the utlägg
 * path, which keeps the invoice currency). Every row counts with its sign, so
 * a rabatt row lowers its rate's moms the way it lowers the invoice's moms
 * total. Reverse-charge fiktiv moms doesn't use this: see
 * groupReverseChargeByRate, which derives the basis directly so fiktiv VAT is
 * always base × statutory rate.
 */
export function groupVatByRate(
  items: Array<Pick<SupplierInvoiceBookingItem, 'line_total' | 'vat_rate' | 'vat_amount'>>,
  toAmount: (vat: number) => number,
  vatTreatment: string | null | undefined,
): Map<number, number> {
  const vatByRate = new Map<number, number>()
  // Second gate on the same contract as itemsHaveVat, which every caller
  // checks first: a stale stored 0.25 must never resurrect 2641.
  if (!treatmentDeductsInputVat(vatTreatment)) return vatByRate
  for (const item of items) {
    const rate = item.vat_rate ?? 0.25
    vatByRate.set(rate, (vatByRate.get(rate) || 0) + toAmount(rowInputVat(item)))
  }
  return vatByRate
}

/**
 * One 2641 line per rate, on the side its net gives it: a rate whose rows net
 * to more moms than its rabatter debits 2641, one whose rabatter outweigh it
 * (a leverantörskreditfaktura keyed in as an invoice) credits it, as an
 * ändringsfaktura lowers the buyer's ingående moms (ML 2023:200 17 kap
 * 22-23 §§). Skipping a rate that nets below zero, as the builders used to,
 * left its moms out of 2641 while the 2440 balance line absorbed it, so the
 * skuld no longer matched the invoice total. A rate that nets to zero books
 * nothing.
 */
export function inputVatLines(
  vatByRate: Map<number, number>,
  description: string,
  dimensions: LineDimensions | undefined,
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  for (const [rate, amount] of vatByRate) {
    const vat = roundOre(amount)
    if (vat === 0) continue
    lines.push({
      account_number: '2641',
      ...debitNatural(vat),
      line_description: `Ingående moms ${Math.round(rate * 100)}% ${description}`,
      dimensions,
    })
  }
  return lines
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
export function groupReverseChargeByRate<T extends SupplierInvoiceBookingItem>(
  items: T[],
  chart: ChartVatTreatments,
  bookedAccount: (item: T) => string,
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
export function slpBaseSek(
  items: Array<Pick<SupplierInvoiceBookingItem, 'apply_slp' | 'account_number' | 'line_total'>>,
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

/**
 * Whether the invoice books omvänd skattskyldighet: the flag, and a supplier
 * type the reverse-charge sets exist for. The only case a builder needs the
 * company's momskoder.
 */
export function isSupplierInvoiceReverseCharge(
  header: Pick<SupplierInvoice, 'reverse_charge'>,
  supplierType: string | null | undefined,
): boolean {
  return (supplierType === 'eu_business' || supplierType === 'non_eu_business' || supplierType === 'swedish_business') &&
    header.reverse_charge === true
}

export interface SupplierInvoiceRegistrationLinesOptions {
  /** See supplierInvoiceRowLines. Default true. */
  deferAccruals?: boolean
}

/**
 * Every line the registration books for the invoice's rows, all but the skuld
 * on 2440: cost per (account, dimensions), ingående moms per rate or the
 * reverse-charge sets, and the SLP pair, each on the side the row's sign
 * gives it. The kreditfaktura (createSupplierCreditNoteEntry) books these same
 * lines on the other side, so an invoice and its credit note net to zero on
 * every account and dimension cell, a row that nets to a credit (rabatt,
 * öresavrundning downwards, the output side of a reverse charge) included.
 * `chart` (the company's momskoder) is read only for a reverse-charge
 * invoice; pass undefined otherwise.
 *
 * `options.deferAccruals` (default true) books a periodiserad row on its
 * 17xx / 29xx interim account. Only a caller that also creates the accrual
 * schedule may leave it on. The kontantmetoden year-end carry passes false:
 * no schedule exists under kontantmetoden, so the cost goes to the row's own
 * account, as the kontantmetoden payment entry books it.
 */
export function supplierInvoiceRowLines(
  header: SupplierInvoiceRegistrationHeader,
  items: SupplierInvoiceBookingItem[],
  supplierType: string | null | undefined,
  desc: string,
  chart: ChartVatTreatments | undefined,
  options: SupplierInvoiceRegistrationLinesOptions = {},
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const bookingAccount = (item: SupplierInvoiceBookingItem): string =>
    (options.deferAccruals ?? true)
      ? resolveBookingAccount('expense', item, item.account_number)
      : item.account_number
  // Dimensions PR7: expense lines carry item bags merged over the invoice
  // default; every other line (VAT, RC/basis, 2440) carries the default only.
  const defaultDimensions = coerceDimensionsBag(header.default_dimensions)

  // Aggregate expense amounts by (account, dimensions) and convert to SEK.
  // Periodiserade lines book their net to the 17xx/29xx interim account instead
  // of the cost account (resolveBookingAccount); VAT and 2440 are untouched:
  // moms is never deferred (redovisas på fakturadatum).
  const expenseBuckets = groupExpenseBuckets(
    items,
    bookingAccount,
    (item) => toSekOrThrow(item.line_total, header.currency, header.exchange_rate),
    defaultDimensions
  )

  // Debit: Expense accounts (in SEK). A bucket that nets below zero (rabatt
  // row, öresavrundning on 3740) books as a credit of the absolute value:
  // every line carries exactly one non-negative side (debitNatural).
  for (const bucket of expenseBuckets) {
    lines.push({
      account_number: bucket.account,
      ...debitNatural(bucket.amount),
      line_description: desc,
      dimensions: bucket.dimensions,
    })
  }

  if (isSupplierInvoiceReverseCharge(header, supplierType)) {
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
    if (!chart) {
      throw new Error('supplierInvoiceRowLines: a reverse-charge invoice needs the company momskoder (fetchChartVatTreatments)')
    }
    const rcByRate = groupReverseChargeByRate(
      items, chart, bookingAccount,
      header.currency, header.exchange_rate,
    )
    const rcSupplierType = supplierType as 'eu_business' | 'non_eu_business' | 'swedish_business'
    for (const [rate, { base, basisBase }] of rcByRate) {
      if (rate > 0 && base > 0) {
        const rcLines = generateReverseChargePurchaseLines({
          base,
          rate,
          kind: supplierInvoiceReverseChargeKind(rcSupplierType, header.reverse_charge_kind),
          basisBase,
        })
        lines.push(...rcLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
      }
    }
  } else if (itemsHaveVat(items, header.vat_treatment)) {
    // Domestic standard: ingående moms per rate group, on its natural side.
    const vatByRate = groupVatByRate(
      items,
      (vat) => toSekOrThrow(vat, header.currency, header.exchange_rate),
      header.vat_treatment,
    )
    lines.push(...inputVatLines(vatByRate, desc, defaultDimensions))
  }

  // Särskild löneskatt på pensionskostnader (SLP, 24.26 %): items flagged
  // apply_slp (tjänstepensionspremier on 741x) get a self-balancing
  // 7533 D / 2514 K pair, injected the same way the reverse-charge pairs are.
  // The pair nets to zero, so the callers' 2440 balance guarantee keeps the
  // payable at the invoice total: SLP is the buyer's own tax, never part of
  // the supplier's fordran.
  const slpBase = slpBaseSek(items, header.currency, header.exchange_rate)
  if (slpBase > 0) {
    const slpLines = generateSlpLines(slpBase)
    lines.push(...slpLines.map((l) => ({ ...l, dimensions: defaultDimensions })))
  }

  return lines
}

/**
 * The whole registration verifikat: the row lines and the skuld on 2440 by
 * their balance (for reverse charge the 26x4 credits already sit among the
 * rows, so they are subtracted). An invoice whose rows net below zero (a
 * leverantörskreditfaktura keyed in as an invoice) books 2440 on the debit
 * side instead of a negative credit.
 */
export function supplierInvoiceRegistrationLines(
  header: SupplierInvoiceRegistrationHeader,
  items: SupplierInvoiceBookingItem[],
  supplierType: string | null | undefined,
  desc: string,
  chart: ChartVatTreatments | undefined,
  options: SupplierInvoiceRegistrationLinesOptions = {},
): CreateJournalEntryLineInput[] {
  const lines = supplierInvoiceRowLines(header, items, supplierType, desc, chart, options)
  const totalDebits = lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredits = lines.reduce((sum, l) => sum + l.credit_amount, 0)
  const isForeign = header.currency !== 'SEK'
  lines.push({
    account_number: '2440',
    ...creditNatural(totalDebits - totalCredits),
    line_description: desc,
    dimensions: coerceDimensionsBag(header.default_dimensions),
    ...buildCurrencyMetadata(header.currency, isForeign ? header.total : undefined, header.exchange_rate),
  })
  return lines
}
