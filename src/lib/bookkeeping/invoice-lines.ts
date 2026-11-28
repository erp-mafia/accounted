/**
 * The pure line builders of the customer-invoice verifikat: per-rate revenue
 * and moms lines, the skattereduktion (1513) lines, the whole registration
 * and credit-note entries (buildInvoiceRegistrationLines,
 * buildCreditNoteLines), the whole kontantmetoden payment entry
 * (buildInvoiceCashLines) and one pro-rata installment of it
 * (buildInvoiceCashPartialLines).
 *
 * No engine, Supabase or logger import, so the browser can run them: the
 * payment dialog proposes the kontantmetoden entry with buildInvoiceCashLines
 * and the send dialog the registration or credit-note entry, instead of
 * hand-kept copies that had drifted (they credited the rate's default account
 * where the invoice line named its own). The engine wrappers that book these
 * lines stay in ./invoice-entries.
 */
import { buildCurrencyMetadata, isLedgerCurrency, resolveSekAmountOrNull } from './currency-utils'
import { resolveBookingAccount } from './accruals/account-suggestions'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  mergeDimensionBags,
  type LineDimensions,
} from './dimension-resolver'
import { splitGrossVat, statedVatFitsRate, treatmentForRate } from './gross-split'
import { getVatRate } from './vat-entries'
import { isOutsideScopeInvoiceTreatment, isZeroRatedInvoiceTreatment, resolveLineVatTreatment } from './invoice-line-vat-treatment'
import { computeLineDeductions, DEDUCTION_TYPE_LABELS } from '@/lib/bookkeeping/rot-rut-rules'
import { creditNatural } from './line-side'
import { InvoiceFxRateMissingError, getOutputVatAccount, getRevenueAccount } from './invoice-accounts'
import { fxDifferenceLine, oreRoundingLine, oreSettlementResidual } from './ore-rounding'
import { getDisplayTotal } from './invoice-rounding'
import { fxDeviationTooLarge } from './fx-settlement'
import { overpaymentAllowed, overpaymentExcess, overpaymentLine } from './overpayment'
import { paymentFeeAllowed, paymentFeeLine, paymentFeeShortfall } from './payment-fee'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import { cashProRataUnsupportedReason, type CashProRataUnsupportedReason } from './booking-mode'
import type {
  CompanySettings,
  CreateJournalEntryLineInput,
  EntityType,
  Invoice,
  InvoiceItem,
  VatTreatment,
} from '@/types'

/**
 * Convert an invoice-currency item amount to SEK for a journal entry line.
 *
 * SEK invoices short-circuit exactly as before, and so does any invoice with a
 * legitimately supplied positive rate: the only new behaviour is the refusal
 * above when a foreign invoice reaches a booking path with no rate at all.
 * `amountSek` is deliberately null: an InvoiceItem has no per-item SEK column,
 * so the rate is the only honest source at item granularity.
 */
function itemToSekOrThrow(
  amount: number,
  currency: string | null | undefined,
  exchangeRate: number | null | undefined
): number {
  const sek = resolveSekAmountOrNull(amount, null, currency, exchangeRate)
  if (sek === null) throw new InvoiceFxRateMissingError(currency || 'okänd valuta')
  return sek
}

/**
 * Convert an invoice-level (header) amount to SEK for a journal entry line.
 *
 * Same refusal contract as `itemToSekOrThrow`, but honours a pre-computed
 * `*_sek` column when the row carries one: header amounts (subtotal /
 * vat_amount / total) have SEK twins that items lack. Rows that DO carry a
 * `*_sek` value or a usable rate convert exactly as before; only the "foreign
 * amount with no SEK source at all" case changes, from silently relabelling
 * the foreign number as kronor (the lenient `resolveSekAmount` ladder, which
 * currency-utils marks READ-ONLY CODE ONLY) to the same INVOICE_FX_RATE_MISSING
 * refusal the item-driven generators raise. Without this, a rate-less foreign
 * invoice booked through a caller without hydrated items posted its raw
 * foreign number as kronor (1 250 EUR → 1 250 kr on 1510): balanced, so no
 * trigger fired, and undetectable downstream.
 */
export function headerToSekOrThrow(
  amount: number,
  amountSek: number | null | undefined,
  currency: string | null | undefined,
  exchangeRate: number | null | undefined
): number {
  const sek = resolveSekAmountOrNull(amount, amountSek, currency, exchangeRate)
  if (sek === null) throw new InvoiceFxRateMissingError(currency || 'okänd valuta')
  return sek
}

/**
 * Build the invoice identifier used in line_description. Prefers the assigned
 * invoice number; falls back to a draft tag with the first 8 chars of the
 * invoice UUID so the verifikation still identifies *vad affärshändelsen avser*
 * per BFL 5 kap 6§ p.3 even if a journal entry is somehow created against an
 * unnumbered invoice. The send path always assigns a number first, so this
 * fallback is defensive, but it leaves no ambiguity if a future caller skips
 * ensureInvoiceNumber.
 */
export function invoiceTag(invoice: Pick<Invoice, 'id' | 'invoice_number'>): string {
  return invoice.invoice_number ?? `utkast ${invoice.id.slice(0, 8)}`
}

/**
 * Build a BFL-compliant verifikation description with event type and counterparty.
 * Falls back to prefix + invoiceNumber if name is not provided (backward compat).
 */
export function buildInvoiceDescription(
  prefix: string, invoiceNumber: string | null, counterpartyName?: string,
  invoiceId?: string,
): string {
  const tag = invoiceNumber ?? (invoiceId ? `utkast ${invoiceId.slice(0, 8)}` : null)
  const tagPart = tag ? ` ${tag}` : ''
  return counterpartyName
    ? `${prefix}${tagPart}, ${counterpartyName}`
    : `${prefix}${tagPart}`
}

/**
 * Whether the VAT an invoice states without per-line rates gets a moms line.
 * The line books the stated figure and never a rate applied to the subtotal:
 * per-line rounding puts the stated VAT öre away from subtotal × rate, the 1510
 * debit takes the stated total, and a recomputed line could not balance.
 *
 * A SEK invoice gets the line only when its VAT fits its one treatment. VAT
 * under a treatment without Swedish VAT, or with none, or further from the
 * treatment's rate than rounding explains (several rates or a momsfri part on
 * one header) would land in the wrong ruta, and the items that could split it
 * are not there. It gets no line: the debit stays above the credits and the
 * engine refuses the entry, as registration always has.
 */
function booksStatedVat(
  statedVat: number,
  subtotal: number,
  treatment: VatTreatment,
  currency: string | null | undefined,
): boolean {
  if (!(statedVat > 0)) return false
  if (!isLedgerCurrency(currency)) return true
  const rate = getVatRate(treatment)
  return treatmentForRate(rate) === treatment && statedVatFitsRate(statedVat, subtotal, rate)
}

/**
 * The text of a revenue line: a sale, or under outside_scope the
 * dröjsmålsränta a räntefaktura charges, which is no sale (the builder holds
 * those lines to interest-income accounts).
 */
function revenueLineText(treatment: VatTreatment | null | undefined, tag: string): string {
  return isOutsideScopeInvoiceTreatment(treatment) ? `Dröjsmålsränta faktura ${tag}` : `Försäljning faktura ${tag}`
}

/**
 * Group invoice items by VAT rate and generate per-rate revenue + VAT lines.
 * Returns credit lines only (revenue + VAT). The caller adds the debit side.
 *
 * options.deferAccruals: substitute the 29xx interim account for lines with a
 * periodisering period. Only the callers that also create/cancel accrual
 * schedules may pass true (invoice entry + credit note): the cash-method
 * entry books revenue directly even if a line carries stale accrual fields,
 * since no schedule would ever dissolve the interim balance.
 *
 * options.defaultDimensions (dimensions PR7): the invoice-level bag. Revenue
 * lines carry item.dimensions merged over it (item wins per key): the merged
 * bag is part of the aggregation identity, so two items on the same
 * rate+account but different tags stay on separate lines. VAT lines carry
 * the default only (the VAT account is a function of the treatment, never of
 * a specific item).
 *
 * options.goodsDeliveryCountry (#2906): the invoice's delivery_country. The
 * zero-rated reverse_charge / export lines of an invoice that stated a goods
 * delivery abroad book the goods accounts (3108 / 3105, rutor 35 / 36)
 * instead of the services ones (getRevenueAccount).
 */
export function generatePerRateLines(
  items: InvoiceItem[],
  invoiceVatTreatment: VatTreatment,
  entityType: EntityType,
  invoiceTagText: string,
  currency?: string | null,
  exchangeRate?: number | null,
  options?: { deferAccruals?: boolean; defaultDimensions?: LineDimensions; goodsDeliveryCountry?: string | null }
): CreateJournalEntryLineInput[] {
  const goodsDeliveryCountry = options?.goodsDeliveryCountry ?? null
  const lines: CreateJournalEntryLineInput[] = []

  // Free-text / blank rows carry no amounts and never book: drop them before
  // grouping so they can't produce a zero-amount revenue line.
  items = items.filter((item) => item.line_type !== 'text')

  // Helper: convert item amount to SEK when dealing with foreign currency.
  // Refuses (InvoiceFxRateMissingError) rather than relabelling the foreign
  // number as kronor: see itemToSekOrThrow above.
  const toSek = (amount: number): number =>
    itemToSekOrThrow(amount, currency, exchangeRate)

  // Check if items have per-line vat_rate set (new invoices)
  const hasPerLineVat = items.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)

  if (!hasPerLineVat) {
    // Legacy fallback: single rate from invoice level. All items collapse
    // into one revenue line, so only the invoice default can apply here:
    // legacy rows predate per-item tagging anyway.
    const revenueAccount = getRevenueAccount(invoiceVatTreatment, entityType, { goods: !!goodsDeliveryCountry })
    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0)
    const subtotalSek = toSek(subtotal)
    lines.push({
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: subtotalSek,
      line_description: revenueLineText(invoiceVatTreatment, invoiceTagText),
      dimensions: options?.defaultDimensions,
    })

    const totalVat = items.reduce((sum, item) => sum + (item.vat_amount || 0), 0)
    if (booksStatedVat(totalVat, subtotal, invoiceVatTreatment, currency)) {
      lines.push({
        account_number: getOutputVatAccount(invoiceVatTreatment),
        debit_amount: 0,
        credit_amount: roundOre(toSek(totalVat)),
        line_description: `Utgående moms faktura ${invoiceTagText}`,
        dimensions: options?.defaultDimensions,
      })
    }
    return lines
  }

  // Group items by vat_rate (preserve first-seen rate order). Within each rate,
  // sub-group revenue by the resolved BAS account + merged dimensions bag so a
  // per-line/article account override (or a per-item dimension tag) produces
  // its own credit line. VAT stays aggregated per rate (the VAT account is a
  // function of the treatment, never of the revenue override).
  type RevenueBucket = {
    account: string
    dimensions?: LineDimensions
    subtotal: number
  }
  type RateGroup = {
    vatAmount: number
    // account + dims bag -> bucket (first-seen order)
    buckets: Map<string, RevenueBucket>
  }
  const rateGroups = new Map<number, RateGroup>()

  for (const item of items) {
    const rate = item.vat_rate ?? 0
    const treatment = resolveLineVatTreatment(rate, invoiceVatTreatment)
    // reverse_charge / reverse_charge_domestic / export force the statutory
    // revenue account (3308/3231/3305, or 3108/3105 for goods delivered
    // abroad); a per-line override only applies to ordinary domestic rates so
    // reverse charge and export sales keep landing in the right
    // VAT-declaration ruta.
    const isSpecialTreatment = isZeroRatedInvoiceTreatment(treatment)
    const plAccount = !isSpecialTreatment && item.revenue_account
      ? item.revenue_account
      : getRevenueAccount(treatment, entityType, { goods: !!goodsDeliveryCountry })
    // Periodiserade lines credit the 29xx interim account (förutbetalda
    // intäkter) instead of revenue; the schedule dissolves it monthly. Output
    // VAT below is untouched. Moms is never deferred. Special treatments are
    // never deferred (ruta 39/40/41 must reflect the full period's sales).
    const account = isSpecialTreatment || !options?.deferAccruals
      ? plAccount
      : resolveBookingAccount('revenue', item, plAccount)

    const dimensions = mergeDimensionBags(options?.defaultDimensions, item.dimensions)
    const bucketKey = `${account}\u0000${dimensionsBagKey(dimensions)}`

    const group = rateGroups.get(rate) ?? { vatAmount: 0, buckets: new Map<string, RevenueBucket>() }
    group.vatAmount += item.vat_amount || 0
    const bucket = group.buckets.get(bucketKey) ?? { account, dimensions, subtotal: 0 }
    bucket.subtotal += item.line_total
    group.buckets.set(bucketKey, bucket)
    rateGroups.set(rate, group)
  }

  // Generate revenue + VAT lines per rate group.
  for (const [rate, group] of rateGroups) {
    const treatment = resolveLineVatTreatment(rate, invoiceVatTreatment)

    // The rate-level rounded subtotal is the balance anchor: identical to the
    // pre-override single-account behaviour. When a rate splits across multiple
    // buckets (account and/or dimensions), distribute that exact total so
    // independent per-bucket rounding can never introduce a 1-öre imbalance
    // against the 1510 debit: every bucket but the last rounds normally; the
    // last absorbs the remainder.
    const rateSubtotalSek = Math.round(
      toSek(Array.from(group.buckets.values()).reduce((sum, b) => sum + b.subtotal, 0)) * 100
    ) / 100

    const buckets = Array.from(group.buckets.values())
    let allocated = 0
    buckets.forEach((bucket, idx) => {
      const isLast = idx === buckets.length - 1
      const credit = isLast
        ? Math.round((rateSubtotalSek - allocated) * 100) / 100
        : Math.round(toSek(bucket.subtotal) * 100) / 100
      allocated = Math.round((allocated + credit) * 100) / 100
      // A bucket that nets below zero (rabatt row, negative correction row)
      // books as a debit of the absolute value: every line carries exactly
      // one non-negative side (creditNatural), never a negative credit.
      lines.push({
        account_number: bucket.account,
        ...creditNatural(credit),
        line_description: revenueLineText(treatment, invoiceTagText),
        dimensions: bucket.dimensions,
      })
    })

    const roundedVat = Math.round(toSek(group.vatAmount) * 100) / 100
    if (roundedVat !== 0) {
      const vatAccount = getOutputVatAccount(treatment)
      lines.push({
        account_number: vatAccount,
        ...creditNatural(roundedVat),
        line_description: `Utgående moms ${rate}% faktura ${invoiceTagText}`,
        dimensions: options?.defaultDimensions,
      })
    }
  }

  return lines
}

/**
 * Each item's skattereduktion in the invoice currency (0 for an item without
 * one), as generateRotRutLines books it.
 *
 * The amounts the invoice stores (invoice_items.deduction_amount, computed
 * server-side by computeLineDeductions when it was saved, never taken from
 * the client): the figures its header, its PDF and the Skatteverket claim
 * carry, so 1513 and the 1510 share follow them exactly. An invoice saved
 * before the whole-krona rule keeps booking the öre amounts it was issued
 * with, and a kreditfaktura (buildCreditNoteItem copies the original's
 * amounts) reverses exactly what the original booked. Rows never saved
 * (the editor's draft voucher preview) carry none and get what saving
 * would store.
 */
function lineDeductionAmounts(
  items: InvoiceItem[],
  currency: string | null | undefined,
  side: 'debit' | 'credit',
): number[] {
  const stored = items.every((item) => !item.deduction_type || item.deduction_amount != null)
  return stored
    ? items.map((item) => Number(item.deduction_amount ?? 0))
    : computeLineDeductions(
        items.map((item) => ({
          unit_price: side === 'credit' ? Math.abs(item.unit_price) : item.unit_price,
          quantity: side === 'credit' ? Math.abs(item.quantity) : item.quantity,
          // The deduction base is the NET line total (rabatt reduces what the
          // customer pays).
          discount_percent: item.discount_percent ?? 0,
          deduction_type: item.deduction_type ?? null,
          // Grön teknik's rate follows the installation type.
          work_type: item.work_type,
          vat_rate: item.vat_rate,
        })),
        { currency },
      )
}

/**
 * Generate skattereduktion (ROT/RUT-avdrag, grön teknik) debit lines from
 * invoice items.
 *
 * For each item flagged with `deduction_type`, produces a debit on BAS 1513
 * (Övriga kortfristiga fordringar, Skatteverket) for the line's deduction
 * amount as the invoice stores it. The caller must REDUCE the 1510 debit
 * (kundfordringar) by the same total: the customer only owes the
 * post-deduction amount; Skatteverket pays the rest (Husavdragstjänsten for
 * ROT/RUT, the e-tjänst Grön teknik: företag for grön teknik). Revenue and
 * utgående moms stay on the full amount: the reduction is a claim on
 * Skatteverket, not a price reduction. Returns both the lines and the total
 * so callers can apply both adjustments atomically.
 *
 * Foreign-currency invoices: ROT/RUT-avdrag is a Sweden-only rule, so
 * receivables on 1513 are always recorded in SEK. We use the same SEK
 * conversion as the rest of the entry (the shared itemToSekOrThrow helper, so
 * this function and generatePerRateLines cannot drift).
 */
export function generateRotRutLines(
  items: InvoiceItem[],
  invoiceTagText: string,
  currency?: string | null,
  exchangeRate?: number | null,
  defaultDimensions?: LineDimensions,
  side: 'debit' | 'credit' = 'debit',
): { lines: CreateJournalEntryLineInput[]; totalSek: number } {
  const lines: CreateJournalEntryLineInput[] = []

  // Same refusal as generatePerRateLines: 1513 is a kronor receivable on
  // Skatteverket, so an unconvertible foreign amount must not land there.
  const toSek = (amount: number): number =>
    itemToSekOrThrow(amount, currency, exchangeRate)

  let totalSek = 0

  const amounts = lineDeductionAmounts(items, currency, side)

  for (const [index, item] of items.entries()) {
    if (!item.deduction_type) continue
    const amount = amounts[index]
    if (amount <= 0) continue
    const amountSek = Math.round(toSek(amount) * 100) / 100
    if (amountSek <= 0) continue
    totalSek += amountSek
    // 'ROT-avdrag', 'RUT-avdrag' or 'Skattereduktion grön teknik'.
    const kind = DEDUCTION_TYPE_LABELS[item.deduction_type].ledger
    lines.push({
      account_number: '1513',
      debit_amount: side === 'debit' ? amountSek : 0,
      credit_amount: side === 'credit' ? amountSek : 0,
      line_description: side === 'credit'
        ? `${kind} kreditfaktura ${invoiceTagText}`
        : `${kind} faktura ${invoiceTagText}`,
      // Per-item line: carries the item's merged bag like its revenue line.
      dimensions: mergeDimensionBags(defaultDimensions, item.dimensions),
    })
  }

  return { lines, totalSek: Math.round(totalSek * 100) / 100 }
}

/**
 * Skatteverket's share of a ROT/RUT or grön teknik invoice, taken off the
 * invoice's own lines for bokslutsmetodens two steps.
 *
 * Bokslutsmetoden reports moms when payment is received (ML 2023:200 7 kap.
 * 16 §), and the skattereduktion is the part of the price Skatteverket pays,
 * so it is received only when the payout arrives. Skatteverket ("Så fungerar
 * rotavdraget", Momsmetoder): a company with bokslutsmetoden reports the moms
 * in two steps, moms on what the customer paid when the customer pays, and
 * "momsen på rotavdraget" when the payout from Skatteverket has arrived. The
 * försäljning behind that moms (its beskattningsunderlag, ruta 05) waits
 * with it.
 *
 * Each deduction line's share is its deduction (kronor, exactly as the 1513
 * leg books it) split at the line's own momssats (splitGrossVat), as
 * Skatteverket computes the moms on the deduction (3 750 kr at 25 % holds
 * 750 kr moms).
 * customerItems are the items with that share taken out, deductionItems one
 * item per deduction line holding only the share. The per-rate builder books
 * both exactly as it books the whole invoice, so per account the two add up,
 * to the öre, to the faktureringsmetod registration
 * (buildInvoiceRegistrationLines). A kreditfaktura's rows carry the credit's
 * sign, and so do both halves.
 *
 * Null when the invoice books in one step: no deduction, a foreign currency
 * (the deduction is a kronor amount; ROT/RUT is never invoiced in another
 * currency), or a deduction line without its own momssats or with a
 * deduction above the line's price (data the split cannot honour).
 */
export interface DeductionShareSplit {
  customerItems: InvoiceItem[]
  deductionItems: InvoiceItem[]
  /** The deduction in kronor (a magnitude): what the payout covers in full. */
  deductionSek: number
}

/** The item holding only `amount` (a magnitude) of a deduction line's price. */
function deductionShareItem(item: InvoiceItem, amount: number, sign: 1 | -1): InvoiceItem {
  const { net: revenue, vat } = splitGrossVat(amount, item.vat_rate / 100)
  return {
    ...item,
    quantity: sign,
    unit_price: revenue,
    discount_percent: 0,
    line_total: sign * revenue,
    vat_amount: sign * vat,
    deduction_amount: amount,
  }
}

/** The sign of an item's price: a kreditfaktura's rows are negative. */
function itemSign(item: InvoiceItem): 1 | -1 {
  return Number(item.line_total ?? 0) + Number(item.vat_amount ?? 0) < 0 ? -1 : 1
}

export function splitDeductionShare(
  items: InvoiceItem[] | undefined,
  currency: string | null | undefined,
): DeductionShareSplit | null {
  if (!items || items.length === 0) return null
  if (!isLedgerCurrency(currency)) return null
  const net = items.reduce((sum, item) => sum + Number(item.line_total ?? 0) + Number(item.vat_amount ?? 0), 0)
  const amounts = lineDeductionAmounts(items, currency, net < 0 ? 'credit' : 'debit')

  const customerItems: InvoiceItem[] = []
  const deductionItems: InvoiceItem[] = []
  let deductionSek = 0
  for (const [index, item] of items.entries()) {
    const amount = item.deduction_type ? roundOre(Math.abs(Number(amounts[index] ?? 0))) : 0
    if (!(amount > 0)) {
      customerItems.push(item)
      continue
    }
    if (item.line_type === 'text' || typeof item.vat_rate !== 'number' || !Number.isFinite(item.vat_rate)) {
      return null
    }
    const sign = itemSign(item)
    const gross = Math.abs(Number(item.line_total ?? 0) + Number(item.vat_amount ?? 0))
    if (amount > roundOre(gross)) return null
    const share = deductionShareItem(item, amount, sign)
    deductionItems.push(share)
    customerItems.push({
      ...item,
      line_total: roundOre(Number(item.line_total) - share.line_total),
      vat_amount: roundOre(Number(item.vat_amount ?? 0) - share.vat_amount),
      deduction_type: null,
      deduction_amount: 0,
    })
    deductionSek = roundOre(deductionSek + amount)
  }
  if (deductionItems.length === 0) return null
  return { customerItems, deductionItems, deductionSek }
}

/**
 * The deduction items scaled to what Skatteverket paid (`paidSek`, a
 * magnitude): its beslut can approve less than the deduction (delvis
 * beviljad). The paid kronor are spread over the lines in proportion to
 * their deduction, the öre left by rounding on the largest, and each line
 * splits its part at its own momssats. The whole deduction or more returns
 * the items as they are.
 */
export function scaleDeductionItems(deductionItems: InvoiceItem[], paidSek: number): InvoiceItem[] {
  const amounts = deductionItems.map((item) => roundOre(Number(item.deduction_amount ?? 0)))
  const total = sumOre(amounts)
  const paid = roundOre(Math.max(0, paidSek))
  if (paid >= total) return deductionItems
  const shares = amounts.map((amount) => (total > 0 ? roundOre((amount * paid) / total) : 0))
  const residual = roundOre(paid - sumOre(shares))
  if (residual !== 0 && shares.length > 0) {
    let largest = 0
    amounts.forEach((amount, i) => {
      if (amount > amounts[largest]) largest = i
    })
    shares[largest] = roundOre(shares[largest] + residual)
  }
  return deductionItems
    .map((item, i) => (shares[i] > 0 ? deductionShareItem(item, shares[i], itemSign(item)) : null))
    .filter((item): item is InvoiceItem => item !== null)
}

/** 'ROT-avdrag', 'RUT-avdrag', 'skattereduktion grön teknik', or 'skattereduktion' for a mix. */
function deductionNoun(items: InvoiceItem[]): string {
  const types = new Set(items.map((item) => item.deduction_type).filter((type) => !!type))
  if (types.size === 1) {
    const [only] = [...types]
    return DEDUCTION_TYPE_LABELS[only as keyof typeof DEDUCTION_TYPE_LABELS]?.noun ?? 'skattereduktion'
  }
  return 'skattereduktion'
}

/**
 * The försäljning and utgående moms of Skatteverket's share (the second
 * step of splitDeductionShare), for the share it paid (`paidSek`; omitted:
 * the whole deduction). Credit lines on the invoice's own revenue and moms
 * accounts and dimensions, exactly the part the kontantmetod payment entry
 * left out. Null when the invoice books in one step.
 */
export function buildDeductionRecognitionLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
  paidSek?: number,
): { lines: CreateJournalEntryLineInput[]; totalSek: number } | null {
  const split = splitDeductionShare(invoice.items, invoice.currency)
  if (!split) return null
  const items = paidSek == null ? split.deductionItems : scaleDeductionItems(split.deductionItems, paidSek)
  if (items.length === 0) return { lines: [], totalSek: 0 }
  const label = deductionNoun(split.deductionItems)
  const lines = generatePerRateLines(
    items, invoice.vat_treatment, entityType, invoiceTag(invoice), 'SEK', null,
    {
      defaultDimensions: coerceDimensionsBag(invoice.default_dimensions),
      goodsDeliveryCountry: invoice.delivery_country,
    },
  )
    .filter((line) => line.debit_amount !== 0 || line.credit_amount !== 0)
    .map((line) => ({ ...line, line_description: `${line.line_description}, ${label}` }))
  const totalSek = roundOre(lines.reduce((sum, line) => sum + line.credit_amount - line.debit_amount, 0))
  return { lines, totalSek }
}

/**
 * The year-end carry of Skatteverket's share alone, for a kontantmetod
 * invoice the customer paid in the year while the payout was still to come
 * (BFL 5 kap 2 §; ML 2023:200 7 kap. 16 §: moms on fordringar unpaid at the
 * beskattningsår's end belongs to its last period): the 1513 fordran per
 * deduction line against the share's försäljning and moms. Together with
 * the payment entry it is the faktureringsmetod registration less the 1510
 * the customer already paid, so the payout after it clears 1513 like any
 * fakturamodellen claim. Null when the invoice books in one step.
 */
export function buildDeductionCarryLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
): CreateJournalEntryLineInput[] | null {
  const recognition = buildDeductionRecognitionLines(invoice, entityType)
  if (!recognition || recognition.totalSek <= 0 || !invoice.items) return null
  const receivable = generateRotRutLines(
    invoice.items, invoiceTag(invoice), invoice.currency, invoice.exchange_rate,
    coerceDimensionsBag(invoice.default_dimensions),
  )
  if (!equalOre(receivable.totalSek, recognition.totalSek)) return null
  return [...receivable.lines, ...recognition.lines]
}

/**
 * The invoice fields the registration and credit-note entries read: the same
 * set as the kontantmetoden entry, so a full Invoice satisfies it and so does
 * the send dialog's invoice.
 */
export type InvoiceRegistrationLinesSource = InvoiceCashLinesSource

/**
 * The faktureringsmetoden registration verifikat of an issued invoice, pure:
 * buildInvoiceJournalEntryInput books exactly these lines, and the send
 * dialog (proposeSendLines) previews them, so the rows a user approves or
 * edits carry what gets booked. Supports per-item VAT rates and revenue
 * accounts; periodiserade lines credit the 29xx interim account.
 *
 *   Debit  1510 Kundfordringar     [total incl VAT, minus ROT/RUT; with
 *                                   options.oreRounding the rounded "Att betala"]
 *   Debit  1513 Skatteverket       [ROT/RUT per item]
 *   Credit 30xx Försäljning        [subtotal per rate and account]
 *   Credit 26xx Utgående moms      [vat per rate]
 *   Cr/Dr  3740 Öresavrundning     [the rounding, no moms (issueOreRoundingDelta)]
 *
 * numberOverride replaces the invoice number in the line texts (self-billing
 * received books under the counterparty's external number).
 *
 * options.deferAccruals (default true) lets periodiserade lines credit their
 * 29xx interim account. Only a caller that also creates the accrual schedule
 * may leave it on. The kontantmetoden year-end carry passes false: no schedule
 * exists under kontantmetoden, so a 29xx balance would never dissolve.
 *
 * options.oreRounding: the issue books the öresavrundning the invoice states
 * (IssueOreRounding): 1510 at the rounded total less ROT/RUT, the difference
 * on 3740. The revenue and moms lines never move. Absent, 1510 carries the
 * exact total: the kontantmetoden year-end carry books it that way.
 */
export function buildInvoiceRegistrationLines(
  invoice: InvoiceRegistrationLinesSource,
  entityType: EntityType,
  numberOverride?: string | null,
  options: { deferAccruals?: boolean; oreRounding?: IssueOreRounding } = {},
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = invoice.currency !== 'SEK'
  const tag = numberOverride ?? invoiceTag(invoice)
  // Dimensions PR7: the invoice default rides every generated line; item bags
  // merge over it inside generatePerRateLines/generateRotRutLines.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Credit lines: revenue + VAT per rate group (compute first to guarantee balance)
  const creditLines: CreateJournalEntryLineInput[] = []

  if (invoice.items && invoice.items.length > 0) {
    creditLines.push(...generatePerRateLines(
      invoice.items, invoice.vat_treatment, entityType, tag,
      invoice.currency, invoice.exchange_rate,
      // Schedules are created right after this entry commits (send/mark-sent
      // flows), so deferring to 29xx here is safe; the year-end carry opts out.
      { deferAccruals: options.deferAccruals ?? true, defaultDimensions, goodsDeliveryCountry: invoice.delivery_country }
    ))
  } else {
    creditLines.push(...headerRecognitionLines(invoice, entityType, tag, defaultDimensions))
  }

  // ROT/RUT-avdrag debit lines (1513 Skatteverket). When present, they
  // reduce the 1510 debit by the same total so the verifikation stays
  // balanced (debits 1510 + 1513 = credits revenue + VAT). The customer
  // only owes the post-deduction amount; Skatteverket pays the rest.
  const rotRut = invoice.items && invoice.items.length > 0
    ? generateRotRutLines(invoice.items, tag, invoice.currency, invoice.exchange_rate, defaultDimensions)
    : { lines: [], totalSek: 0 }

  // Debit: Kundfordringar, balance guarantee: debit = NET of all revenue/VAT
  // lines (a negative rabatt/avrundning row sits on the debit side after
  // creditNatural, so it must subtract) MINUS the ROT/RUT total which goes
  // to 1513 instead.
  const totalCredits = creditLines.reduce((sum, l) => sum + l.credit_amount - l.debit_amount, 0)
  const debitAmount = isForeign
    ? Math.round(totalCredits * 100) / 100
    : headerToSekOrThrow(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
  const exactAmount = roundOre(debitAmount - rotRut.totalSek)
  // Öresavrundning is for SEK only, so the delta is already kronor. A ROT/RUT
  // invoice keeps the exact total (issueOreRoundingDelta).
  const rounding = rotRut.totalSek !== 0 ? 0 : issueOreRoundingDelta(invoice, exactAmount, options.oreRounding)
  const arAmount = roundOre(exactAmount + rounding)

  lines.push({
    account_number: '1510',
    debit_amount: arAmount,
    credit_amount: 0,
    line_description: `Faktura ${tag}`,
    dimensions: defaultDimensions,
    ...buildCurrencyMetadata(invoice.currency, isForeign ? invoice.total : undefined, invoice.exchange_rate),
  })

  lines.push(...rotRut.lines)
  lines.push(...creditLines)
  if (rounding !== 0) lines.push(issueOreRoundingLine(rounding, defaultDimensions))

  return lines
}

/**
 * How an issue verifikat books the öresavrundning the document states:
 *
 *   { company }        an invoice: its own ore_rounding, else the company's
 *                      setting, read by getDisplayTotal exactly as the PDF and
 *                      "Att betala" read it;
 *   { mirror: number } a full kreditfaktura of an original whose issue
 *                      verifikat booked this öre on 1510 (issueBookedOre:
 *                      0,25 for 999,75 booked at 1 000, -0,50 for 1 000,50
 *                      booked at 1 000). The credit takes exactly that back,
 *                      whatever its own flag or the company setting says
 *                      today, so the pair nets to zero on 1510 and 3740.
 *
 * Absent, the lines carry the exact total: the kontantmetoden year-end carry,
 * and a kreditfaktura of an original booked at the exact total (every invoice
 * issued before the issue verifikat booked the öre).
 */
export type IssueOreRounding =
  | { company: Pick<CompanySettings, 'ore_rounding'> | null }
  | { mirror: number }

/**
 * The öresavrundning an issue verifikat books on 1510 and 3740: the rounded
 * total less the exact one (getDisplayTotal's roundingDelta, signed: 0,25 for
 * 999,75 shown as 1 000, -0,40 for 1 000,40), or for a mirroring kreditfaktura
 * the negated öre its original booked (-0,25 for a credit of -999,75), 0 when
 * none applies. Under faktureringsmetoden the receivable is booked when
 * the invoice is issued, at what the invoice claims (BFL 1 kap 2 § p. 7 and
 * 5 kap 2 §, BFNAR 2013:2 p. 3.4); 3740 carries no moms. Every settlement
 * door then clears what 1510 carries and books only the öre left
 * (bookedOreRounding), and the kundreskontra counts the same
 * (lib/reports/reskontra-issue-ore.ts).
 *
 * Never for a received självfaktura (the buyer's document, booked as it
 * states it), nor for a ROT/RUT invoice: a refused deduction moves part of
 * 1513 back onto 1510 in a verifikat of its own, which the settlement doors'
 * read of what 1510 carries (document_carried_sek) does not follow, so such
 * an invoice keeps the exact total and its öre lands on 3740 at payment, as
 * before. Not either when the rounded receivable would not keep its sign or
 * when the öre is past FX_SAME_DOCUMENT_LIMIT of it (an invoice of a few
 * kronor): the settlement doors read a gap that large as a rättelse of the
 * debt, not rounding, so such an invoice keeps the exact total and its öre
 * lands on 3740 when it is paid, as before.
 *
 * `exactReceivableSek` is the 1510 figure without rounding, signed as the
 * document's total.
 */
export function issueOreRoundingDelta(
  document: Pick<InvoiceRegistrationLinesSource, 'total' | 'currency' | 'ore_rounding' | 'is_self_billed' | 'deduction_total'>,
  exactReceivableSek: number,
  oreRounding: IssueOreRounding | undefined,
): number {
  if (!oreRounding || document.is_self_billed || !isLedgerCurrency(document.currency)) return 0
  let rounding: number
  if ('mirror' in oreRounding) {
    // What the original's verifikat booked (issueBookedOre, inside the öre band).
    rounding = roundOre(-oreRounding.mirror)
  } else {
    if ((Number(document.deduction_total) || 0) > 0) return 0
    const { applies, roundingDelta } = getDisplayTotal(document, oreRounding.company)
    rounding = applies ? roundOre(roundingDelta) : 0
  }
  if (rounding === 0) return 0
  const rounded = roundOre(exactReceivableSek + rounding)
  if (rounded === 0 || Math.sign(rounded) !== Math.sign(exactReceivableSek)) return 0
  if (fxDeviationTooLarge(rounded, exactReceivableSek)) return 0
  return rounding
}

/**
 * The 3740 line of an issue's öresavrundning: credited when the total was
 * rounded up (1510 carries more than the sale), debited when rounded down.
 * The customer side of oreRoundingLine, with the delta as what a bank would
 * move short of the claim.
 */
function issueOreRoundingLine(
  delta: number,
  dimensions: CreateJournalEntryLineInput['dimensions'],
): CreateJournalEntryLineInput {
  return { ...oreRoundingLine(-delta, 'customer'), dimensions }
}

/**
 * The two-step split of a kreditfaktura (buildCreditNoteLines'
 * options.deductionBookedSek): the customer's rows, and of Skatteverket's
 * share the rows its payout booked. Null when the credit reverses the whole
 * invoice: no two steps, or the payout booked the whole share.
 */
export function creditNoteDeductionSplit(
  creditNote: Pick<InvoiceRegistrationLinesSource, 'items' | 'currency'>,
  deductionBookedSek: number | null | undefined,
): { customerItems: InvoiceItem[]; bookedItems: InvoiceItem[] } | null {
  if (deductionBookedSek == null) return null
  const split = splitDeductionShare(creditNote.items, creditNote.currency)
  if (!split) return null
  const booked = roundOre(Math.max(0, deductionBookedSek))
  if (booked >= split.deductionSek) return null
  return { customerItems: split.customerItems, bookedItems: scaleDeductionItems(split.deductionItems, booked) }
}

/**
 * The credit-note verifikat (reversed version of the original invoice entry),
 * pure: createCreditNoteJournalEntry books exactly these lines, and the send
 * dialog previews them. Supports per-item VAT rates and revenue accounts with
 * reversed debit/credit sides.
 *
 *   Debit  30xx Försäljning         [subtotal per rate and account]
 *   Debit  26xx Utgående moms       [vat per rate]
 *   Credit 1510 Kundfordringar      [total, minus ROT/RUT]
 *   Credit 1513 Skatteverket        [ROT/RUT per item]
 *
 * The credit note's rows are the original's negated by their sign
 * (buildCreditNoteItem), so the same per-rate builder the registration uses
 * lands every line on the other side of the original's on its own:
 * a bucket that nets to a reduction on the original (a rabatt or
 * öresavrundning row on its own account) is credited here, and one rate's
 * moms is debited by the original's net moms. The original and its full
 * credit note then net to zero on every account and dimension cell, 1510
 * included (accounted#58).
 *
 * originalVoucherRef (e.g. "A-42") is embedded in the line texts: BFL 5 kap.
 * 5 § requires a correction to point back to the corrected verifikation.
 *
 * options.deferAccruals: as on buildInvoiceRegistrationLines (default true;
 * the kontantmetoden year-end carry passes false).
 *
 * options.deductionBookedSek: the original is a kontantmetod ROT/RUT invoice
 * on the two steps (getDeductionShareBookedByPayout): its payment booked the
 * customer's share and its payout this many kronor of Skatteverket's share,
 * 0 while no payout has. The credit reverses what the ledger holds: the
 * customer's share back onto 1510, and of Skatteverket's share exactly what
 * the payout booked (scaleDeductionItems, the payout's own scaling), with a
 * 1513 credit of it: what Skatteverket paid and is owed back. A share still
 * pending or refused was never booked and is not reversed. Undefined, null
 * or the whole share: the full reversal.
 *
 * options.oreRounding: { mirror } for a full credit of an original whose
 * issue verifikat booked that öresavrundning on 1510 (IssueOreRounding): 1510
 * is credited what the original put there and 3740 takes exactly that öre
 * back, so the original and its credit net to zero on both. Never on the two
 * steps above: a kontantmetod original has no issue verifikat that rounded.
 */
export function buildCreditNoteLines(
  creditNote: InvoiceRegistrationLinesSource,
  entityType: EntityType,
  originalVoucherRef?: string,
  options: { deferAccruals?: boolean; deductionBookedSek?: number | null; oreRounding?: IssueOreRounding } = {},
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const tag = invoiceTag(creditNote)
  const lineSuffix = originalVoucherRef ? ` (avser ${originalVoucherRef})` : ''
  // Dimensions PR7: the credit note's bag (copied from the original at credit
  // time) so the reversal nets against the same dimension cells in reports.
  const defaultDimensions = coerceDimensionsBag(creditNote.default_dimensions)
  const split = creditNoteDeductionSplit(creditNote, options.deductionBookedSek)
  const creditItems = split ? [...split.customerItems, ...split.bookedItems] : creditNote.items

  // Revenue + VAT lines per rate group, each on its natural side for the
  // credit note's signed amounts: the other side of the original's.
  const reversalLines: CreateJournalEntryLineInput[] = []

  if (creditItems && creditItems.length > 0) {
    const perRateLines = generatePerRateLines(
      creditItems, creditNote.vat_treatment, entityType, tag,
      creditNote.currency, creditNote.exchange_rate,
      // Credit-note items carry the original's accrual fields so the reversal
      // hits the same 29xx interim account; the original's schedule is
      // cancelled/stornoed by the credit flow. delivery_country is copied
      // from the original too, so goods revenue reverses on 3105 / 3108.
      { deferAccruals: options.deferAccruals ?? true, defaultDimensions, goodsDeliveryCountry: creditNote.delivery_country }
    )
    // No side is forced here: the rows already carry the credit's sign
    // (buildCreditNoteItem), and generatePerRateLines books each bucket by
    // creditNatural. Forcing every line to the debit side (the old
    // |net| rule) credited a rabatt row on the original's own side.
    for (const line of perRateLines) {
      reversalLines.push({
        ...line,
        line_description: `Kreditfaktura ${tag}${lineSuffix}`,
      })
    }
  } else {
    // Fallback: invoice-level amounts, signed as the credit note's header
    // carries them (buildCreditNoteFields). Same strict conversion as the
    // registration fallback above: a rate-less foreign credit note must
    // refuse, not reverse the receivable with a mislabelled number.
    const revenueAccount = getRevenueAccount(creditNote.vat_treatment, entityType, { goods: !!creditNote.delivery_country })
    const subtotalSek = headerToSekOrThrow(creditNote.subtotal, creditNote.subtotal_sek, creditNote.currency, creditNote.exchange_rate)
    const vatSek = headerToSekOrThrow(creditNote.vat_amount, creditNote.vat_amount_sek, creditNote.currency, creditNote.exchange_rate)

    reversalLines.push({
      account_number: revenueAccount,
      ...creditNatural(subtotalSek),
      line_description: `Kreditfaktura ${tag}`,
      dimensions: defaultDimensions,
    })

    if (roundOre(vatSek) !== 0) {
      const vatAccount = getOutputVatAccount(creditNote.vat_treatment)
      reversalLines.push({
        account_number: vatAccount,
        ...creditNatural(vatSek),
        line_description: `Moms kreditfaktura ${tag}${lineSuffix}`,
        dimensions: defaultDimensions,
      })
    }
  }

  lines.push(...reversalLines)

  // ROT/RUT reverses the exact receivable split used by the original invoice:
  // 1510 for the customer portion and 1513 for the Skatteverket portion
  // (under the two steps only what its payout booked, none before it).
  const rotRut = split
    ? generateRotRutLines(
        split.bookedItems,
        tag,
        creditNote.currency,
        creditNote.exchange_rate,
        defaultDimensions,
        'credit',
      )
    : creditNote.items && creditNote.items.length > 0
    ? generateRotRutLines(
        creditNote.items,
        tag,
        creditNote.currency,
        creditNote.exchange_rate,
        defaultDimensions,
        'credit',
      )
    : { lines: [], totalSek: 0 }

  // Credit: Kundfordringar, balance guarantee: 1510 + 1513 equal the NET of
  // the revenue/VAT lines (a credited rabatt row subtracts), on 1510's
  // natural side for what the credit takes off the receivable.
  const netDebits = reversalLines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)
  const exactReceivable = roundOre(netDebits - rotRut.totalSek)
  // The credit's own öresavrundning on its signed (negative) receivable:
  // -0,25 on -999,75, so 1510 is credited 1 000 and 3740 debited 0,25.
  const rounding = split ? 0 : issueOreRoundingDelta(creditNote, -exactReceivable, options.oreRounding)
  const customerReceivable = roundOre(exactReceivable - rounding)
  lines.push({
    account_number: '1510',
    ...creditNatural(customerReceivable),
    line_description: `Kreditfaktura ${tag}`,
    dimensions: defaultDimensions,
  })
  lines.push(...rotRut.lines)
  if (rounding !== 0) lines.push(issueOreRoundingLine(rounding, defaultDimensions))

  return lines
}

/**
 * The invoice fields the kontantmetoden entry reads. A full Invoice satisfies
 * it; so does the payment dialog's proposal input.
 */
export interface InvoiceCashLinesSource {
  id: string
  invoice_number: string | null
  currency: string
  exchange_rate?: number | null
  vat_treatment: VatTreatment
  delivery_country?: string | null
  subtotal: number
  subtotal_sek?: number | null
  vat_amount: number
  vat_amount_sek?: number | null
  total: number
  total_sek?: number | null
  items?: InvoiceItem[]
  default_dimensions?: Record<string, string> | null
  /**
   * ROT/RUT or grön teknik deduction, invoice currency. Read only by the
   * pro-rata builder, which refuses such invoices; the whole-payment entry
   * derives the 1513 legs from the items.
   */
  deduction_total?: number | null
  /** The invoice's own öresavrundning choice; null follows the company setting (getDisplayTotal). */
  ore_rounding?: boolean | null
  /** A received självfaktura: the buyer's document, booked as it states it (no öresavrundning). */
  is_self_billed?: boolean | null
}

/**
 * The SEK that arrived on the bank row a kontantmetoden payment is matched
 * to, for buildInvoiceCashLines' `knownBankSek`: on a SEK invoice the base
 * of the öresavrundning, on a foreign invoice of the kursdiff. Undefined
 * unless the row is in SEK (a row on a foreign-currency account books the
 * customer share at the invoice's rate). One derivation for the match route,
 * its preview and createInvoiceCashEntry, so what the dialog shows is what
 * gets booked.
 */
export function invoiceCashBankSek(
  bankTransaction?: { amount: number; currency?: string | null } | null,
): number | undefined {
  if (!bankTransaction || bankTransaction.currency !== 'SEK') return undefined
  return roundOre(Math.abs(bankTransaction.amount))
}

/**
 * The revenue and moms lines of the kontantmetoden entry: everything but the
 * settlement leg, the 1513 legs and the öresavrundning line. Per-rate lines
 * from the items, or the invoice-level fallback when no items are loaded.
 * One builder for the whole-payment entry and the pro-rata installments, so
 * the installments of a split payment add up to exactly what one payment of
 * the whole invoice books.
 */
function cashRecognitionLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
  tag: string,
  defaultDimensions: LineDimensions | undefined,
): CreateJournalEntryLineInput[] {
  if (invoice.items && invoice.items.length > 0) {
    return generatePerRateLines(
      invoice.items, invoice.vat_treatment, entityType, tag,
      invoice.currency, invoice.exchange_rate,
      { defaultDimensions, goodsDeliveryCountry: invoice.delivery_country }
    )
  }

  return headerRecognitionLines(invoice, entityType, tag, defaultDimensions)
}

/**
 * The revenue and moms lines of an invoice booked from its header, when no
 * items are loaded: the amounts the invoice states, the registration and the
 * kontantmetoden entry alike. Strict conversion: a rate-less foreign header
 * refuses exactly like the item-driven path, it never posts the raw foreign
 * number as kronor.
 */
function headerRecognitionLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
  tag: string,
  defaultDimensions: LineDimensions | undefined,
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = [{
    account_number: getRevenueAccount(invoice.vat_treatment, entityType, { goods: !!invoice.delivery_country }),
    debit_amount: 0,
    credit_amount: headerToSekOrThrow(invoice.subtotal, invoice.subtotal_sek, invoice.currency, invoice.exchange_rate),
    line_description: revenueLineText(invoice.vat_treatment, tag),
    dimensions: defaultDimensions,
  }]

  if (booksStatedVat(invoice.vat_amount, invoice.subtotal, invoice.vat_treatment, invoice.currency)) {
    lines.push({
      account_number: getOutputVatAccount(invoice.vat_treatment),
      debit_amount: 0,
      credit_amount: headerToSekOrThrow(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate),
      line_description: `Utgående moms faktura ${tag}`,
      dimensions: defaultDimensions,
    })
  }

  return lines
}

/**
 * The kontantmetoden (cash method) verifikat for a received payment, pure:
 * createInvoiceCashEntry books exactly these lines, and the bank-match
 * preview and the payment dialog (proposePaymentLines) show them, so the
 * rows a user approves or edits carry what gets booked, the invoice's
 * dimensions included. Supports per-item VAT rates. Revenue + VAT
 * recognised at payment.
 *
 *   Debit  1930 Företagskonto       [customer share, or the bank amount]
 *   Debit  1513 Skatteverket        [ROT/RUT deduction]  (one step only)
 *   Credit 30xx Försäljning         [subtotal per rate]
 *   Credit 26xx Utgående moms       [vat per rate]  (if applicable)
 *   Dr/Cr  3740 Öresavrundning      [bank vs share gap, plus a header total
 *                                    rounded off its rows]  (if applicable)
 *   Dr/Cr  7960/3960 Kursdiff       [foreign invoice: bank vs share]  (if applicable)
 *   Credit 2420/3740 Överbetalning  [bank above share]   (if applicable)
 *   Debit  6570 Avgift betaltjänst  [bank below share]   (if applicable)
 *
 * `knownBankSek`: the SEK that actually arrived (invoiceCashBankSek), when
 * the payment is matched to a bank row. On a SEK invoice a gap under one
 * krona to the customer share is öresavrundning: 1930 takes what arrived and
 * 3740 the gap (customer side of oreRoundingLine), so 1930 follows the bank
 * statement. Revenue and moms stay on the invoice amounts: 3740 carries no
 * VAT. An exact row and a gap of a krona or more (the routes refuse those
 * before booking) book the customer share as before. On a foreign invoice
 * revenue and moms stay at the invoice's rate (the rate of the taxable
 * event), 1930 takes what arrived and the gap is the realised kursvinst
 * (3960) or kursförlust (7960), as the faktureringsmetoden clearing books it
 * (crm#1551).
 *
 * `overpaymentAccount`: when the row brought a krona or more ABOVE the
 * customer share and this names an account allowed to take the excess
 * (overpayment.ts), 1930 takes what arrived and that account the excess.
 * Revenue and moms stay on the invoice amounts.
 *
 * `options.feeAccount`: when the row brought a krona or more BELOW the
 * customer share and this names an account allowed to take the shortfall as
 * the payment provider's fee (payment-fee.ts), 1930 takes what arrived (the
 * payout) and that account the fee. Revenue and moms stay on the invoice
 * amounts: the customer paid them in full (crm#1364). On a ROT/RUT invoice
 * the fee is measured against the customer share only: it is a shortfall of
 * the customer's payment, and Skatteverket's share (1513, or the second step
 * below) is untouched.
 *
 * `options.deferDeductionShare` (kontantmetoden, i.e. bokslutsmetoden, only):
 * a ROT/RUT or grön teknik invoice books its first step only, the försäljning
 * and moms of what the customer pays, with no 1513 leg; Skatteverket's share
 * is booked when its payout arrives (splitDeductionShare,
 * buildDeductionRecognitionLines), or by the year-end carry while it is
 * still to come. Off, the deduction is a 1513 fordran booked here with the
 * full revenue and moms: right for a kontantfaktura under
 * faktureringsmetoden, which reports the whole moms at issue.
 */
export function buildInvoiceCashLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
  customerName: string | undefined,
  settlementAccountNumber: string,
  knownBankSek?: number,
  overpaymentAccount?: string,
  options: { deferDeductionShare?: boolean; feeAccount?: string } = {},
): { description: string; lines: CreateJournalEntryLineInput[] } {
  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = invoice.currency !== 'SEK'
  const tag = invoiceTag(invoice)
  // Dimensions PR7: kontantmetoden books revenue at payment, so this IS the
  // producer path for cash-method companies: same merge rules as issuance.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Bokslutsmetoden's first step: the customer's share only.
  const split = options.deferDeductionShare ? splitDeductionShare(invoice.items, invoice.currency) : null

  // Credit lines: revenue + VAT per rate group (compute first to guarantee balance)
  const creditLines = cashRecognitionLines(
    split ? { ...invoice, items: split.customerItems } : invoice,
    entityType, tag, defaultDimensions,
  )

  // ROT/RUT-avdrag debit lines (1513 Skatteverket). On cash method the
  // bank account (1930) receives only the post-deduction amount in real
  // life; the rest comes from Skatteverket later. We model that by
  // splitting the debit: 1930 = total - deduction, 1513 = deduction. Under
  // the two steps nothing goes on 1513: the deduction is a fordran
  // kontantmetoden does not book until the payout (or the year end).
  const rotRut = split
    ? { lines: [] as CreateJournalEntryLineInput[], totalSek: split.deductionSek }
    : invoice.items && invoice.items.length > 0
      ? generateRotRutLines(invoice.items, tag, invoice.currency, invoice.exchange_rate, defaultDimensions)
      : { lines: [], totalSek: 0 }

  // Debit: Företagskonto, balance guarantee: debit = sum of credit lines
  // minus the ROT/RUT total which goes to 1513 instead.
  // NET of the revenue/VAT lines: a negative row sits on the debit side.
  const totalCredits = creditLines.reduce((sum, l) => sum + l.credit_amount - l.debit_amount, 0)
  const cashDebit = isForeign
    ? Math.round(totalCredits * 100) / 100
    : headerToSekOrThrow(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
  const customerShare = roundOre(cashDebit - rotRut.totalSek)
  const knowsBank = !isForeign && customerShare > 0 && knownBankSek != null && knownBankSek > 0
  const oreGap = knowsBank ? oreSettlementResidual(customerShare, knownBankSek) : 0
  const excess = knowsBank ? overpaymentExcess(customerShare, knownBankSek) : 0
  const overpayment =
    excess !== 0 && overpaymentAccount && overpaymentAllowed(overpaymentAccount, excess) ? excess : 0
  const { feeAccount } = options
  const shortfall = knowsBank ? paymentFeeShortfall(customerShare, knownBankSek) : 0
  const fee =
    shortfall !== 0 && feeAccount && paymentFeeAllowed(feeAccount, shortfall, customerShare) ? shortfall : 0
  // A foreign invoice settled by a known SEK amount: the customer share is
  // the invoice's foreign amount at its own rate, so the whole gap to what
  // arrived is kursdiff (the match doors settle in full only within
  // FX_FULL_SETTLEMENT_BAND). > 0 is a gain.
  const fxGain =
    isForeign && customerShare > 0 && knownBankSek != null && knownBankSek > 0
      ? roundOre(knownBankSek - customerShare)
      : 0
  const bankAmount = roundOre(customerShare - oreGap + overpayment - fee + fxGain)
  // The invoice's own öresavrundning: a SEK header whose total is the rounded
  // amount to pay while its rows carry the öre (an invoice imported with Att
  // betala as its total, the rounding folded into the header net). The debit
  // side books what is owed and the credit side the rows, so the gap goes on
  // 3740, as the source system booked it, on a line of its own beside any
  // bank-vs-share öre gap. Only when the debit side is the rows' total rounded
  // to whole kronor by the öresavrundning rule (getDisplayTotal), and the
  // header's moms is the moms the rows book: then the whole gap sits in the
  // net and is rounding of the amount to pay. Any other gap is left as before,
  // and the engine refuses the unbalanced entry.
  const debitSide = roundOre(customerShare + sumOre(rotRut.lines.map((l) => l.debit_amount - l.credit_amount)))
  const rowsTotal = roundOre(totalCredits)
  const invoiceOre =
    !isForeign &&
    rowsTotal !== debitSide &&
    getDisplayTotal({ total: rowsTotal, currency: 'SEK', ore_rounding: true }, null).displayed === debitSide &&
    equalOre(
      installmentOutputVat(creditLines),
      headerToSekOrThrow(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate),
    )
      ? roundOre(rowsTotal - debitSide)
      : 0
  lines.push({
    account_number: settlementAccountNumber,
    debit_amount: bankAmount,
    credit_amount: 0,
    line_description: buildInvoiceDescription('Kontantbetalning kundfaktura', invoice.invoice_number, customerName, invoice.id),
    dimensions: defaultDimensions,
  })

  lines.push(...rotRut.lines)
  lines.push(...creditLines)
  if (invoiceOre !== 0) {
    lines.push({ ...oreRoundingLine(invoiceOre, 'customer'), dimensions: defaultDimensions })
  }
  if (oreGap !== 0) {
    lines.push({ ...oreRoundingLine(oreGap, 'customer'), dimensions: defaultDimensions })
  }
  if (overpayment !== 0) {
    lines.push({ ...overpaymentLine(overpayment, overpaymentAccount!), dimensions: defaultDimensions })
  }
  if (fee !== 0) {
    lines.push({ ...paymentFeeLine(fee, feeAccount!), dimensions: defaultDimensions })
  }
  if (fxGain !== 0) {
    lines.push({ ...fxDifferenceLine(fxGain), dimensions: defaultDimensions })
  }

  return {
    description: buildInvoiceDescription('Kontantbetalning kundfaktura', invoice.invoice_number, customerName, invoice.id),
    lines,
  }
}

/** One installment of a split kontantmetoden payment, in SEK. */
export interface InvoiceCashInstallment {
  /** paid_amount before this payment. */
  priorPaid: number
  /** This payment. */
  amount: number
}

export type InvoiceCashPartialRefusal =
  | CashProRataUnsupportedReason
  /** The revenue and moms lines do not add up to the invoice total. */
  | 'lines_do_not_match_total'
  /** Not a positive payment inside what is still owed. */
  | 'invalid_amount'

export type InvoiceCashPartialLines =
  | {
      ok: true
      description: string
      lines: CreateJournalEntryLineInput[]
      /** paid_amount after this payment; exactly the total when it settles the invoice. */
      paidAfter: number
      /** True when this payment settles what is left of the invoice. */
      settles: boolean
      /**
       * Net credit (credit minus debit) per revenue and moms account that the
       * installments before this one recognised under this rule: what the
       * ledger must already hold for the invoice before this entry may book.
       */
      recognisedBefore: Record<string, number>
    }
  | { ok: false; reason: InvoiceCashPartialRefusal }

/** Output VAT accounts (26xx) never absorb the rounding residual. */
function isOutputVatLine(line: CreateJournalEntryLineInput): boolean {
  return line.account_number.startsWith('26')
}

/** The utgående moms an installment's lines book: the net credit on its moms lines. */
export function installmentOutputVat(lines: readonly CreateJournalEntryLineInput[]): number {
  return roundOre(
    lines
      .filter(isOutputVatLine)
      .reduce((sum, line) => sum + (line.credit_amount ?? 0) - (line.debit_amount ?? 0), 0),
  )
}

/**
 * The line that absorbs the öre residual of a cumulative split: the largest
 * revenue line (first on a tie), so every moms line stays the plain rounded
 * share of its rate. Falls back to the largest line of any kind.
 */
function residualAnchor(lines: CreateJournalEntryLineInput[], amounts: number[]): number {
  let anchor = -1
  amounts.forEach((amount, i) => {
    if (isOutputVatLine(lines[i])) return
    if (anchor === -1 || Math.abs(amount) > Math.abs(amounts[anchor])) anchor = i
  })
  if (anchor !== -1) return anchor
  amounts.forEach((amount, i) => {
    if (anchor === -1 || Math.abs(amount) > Math.abs(amounts[anchor])) anchor = i
  })
  return anchor
}

/**
 * What the installments up to a cumulative `paid` have recognised on each
 * line: each line's pro-rata share, rounded to the öre, with the residual
 * that makes the shares add up to `paid` on the anchor line. A deterministic
 * function of `paid` alone, so the share of one installment is the
 * difference of two calls, the installments telescope, and the last one
 * (paid equal to the total) lands every line on its full amount exactly.
 */
function cumulativeCashRecognition(
  amounts: number[],
  total: number,
  paid: number,
  anchor: number,
): number[] {
  if (paid <= 0) return amounts.map(() => 0)
  if (paid >= total) return [...amounts]
  const shares = amounts.map((amount) => roundOre((amount * paid) / total))
  const residual = roundOre(paid - sumOre(shares))
  shares[anchor] = roundOre(shares[anchor] + residual)
  return shares
}

/**
 * How every pro-rata installment but the last begins its description (the
 * last reads "Kontant slutbetalning kundfaktura"). Only this builder writes
 * it, so the systemdokumentation tells from it whether a company has part
 * payments booked by the rule.
 */
export const CASH_PARTIAL_FIRST_DESCRIPTION = 'Kontant delbetalning kundfaktura'

/**
 * The kontantmetoden verifikat for ONE installment of a never-booked
 * customer invoice, pure: revenue and utgående moms per rate (and per
 * revenue account and dimension bag, as on the whole-payment entry) in
 * proportion to the amount received.
 *
 *   Debit  1930 Företagskonto       [the installment]
 *   Credit 30xx Försäljning         [the installment's share per rate/account]
 *   Credit 26xx Utgående moms       [the installment's share per rate]
 *
 * Bokslutsmetoden reports moms when payment is received, so each installment
 * carries the moms it contains and nothing more; the whole-payment entry
 * (buildInvoiceCashLines) would declare the whole invoice's moms on the first
 * installment. The shares are cumulative (see cumulativeCashRecognition), so
 * however the invoice is split, the installments together book exactly the
 * lines one payment of the whole invoice would, per account and to the öre,
 * and a later credit note (buildCreditNoteLines) reverses them exactly. Each
 * moms line of an installment is within one öre of the exact pro-rata share.
 *
 * Refuses foreign-currency and ROT/RUT/grön teknik invoices
 * (cashProRataUnsupportedReason), an invoice whose lines do not add up to its
 * total, and an amount that is not positive or exceeds what is still owed.
 * Assumes the earlier installments were booked by this builder: the caller
 * verifies that against the ledger with `recognisedBefore` before booking.
 */
export function buildInvoiceCashPartialLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
  installment: InvoiceCashInstallment,
  customerName: string | undefined,
  settlementAccountNumber: string,
): InvoiceCashPartialLines {
  const unsupported = cashProRataUnsupportedReason(invoice)
  if (unsupported) return { ok: false, reason: unsupported }

  const total = roundOre(invoice.total)
  const priorPaid = roundOre(installment.priorPaid)
  const amount = roundOre(installment.amount)
  if (!(total > 0) || !(amount > 0) || priorPaid < 0 || !(priorPaid < total)) {
    return { ok: false, reason: 'invalid_amount' }
  }
  const paidAfterRaw = roundOre(priorPaid + amount)
  if (paidAfterRaw > total && !equalOre(paidAfterRaw, total)) {
    return { ok: false, reason: 'invalid_amount' }
  }
  const settles = equalOre(paidAfterRaw, total)
  const paidAfter = settles ? total : paidAfterRaw

  const tag = invoiceTag(invoice)
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)
  const recognition = cashRecognitionLines(invoice, entityType, tag, defaultDimensions)
  const amounts = recognition.map((line) => roundOre(line.credit_amount - line.debit_amount))
  if (recognition.length === 0 || !equalOre(sumOre(amounts), total)) {
    return { ok: false, reason: 'lines_do_not_match_total' }
  }

  const anchor = residualAnchor(recognition, amounts)
  const before = cumulativeCashRecognition(amounts, total, priorPaid, anchor)
  const after = cumulativeCashRecognition(amounts, total, paidAfter, anchor)

  const description = buildInvoiceDescription(
    settles ? 'Kontant slutbetalning kundfaktura' : CASH_PARTIAL_FIRST_DESCRIPTION,
    invoice.invoice_number,
    customerName,
    invoice.id,
  )
  const lines: CreateJournalEntryLineInput[] = [
    {
      account_number: settlementAccountNumber,
      debit_amount: roundOre(paidAfter - priorPaid),
      credit_amount: 0,
      line_description: description,
      dimensions: defaultDimensions,
    },
  ]
  recognition.forEach((line, i) => {
    const share = roundOre(after[i] - before[i])
    if (share === 0) return
    lines.push({ ...line, ...creditNatural(share) })
  })

  const recognisedBefore: Record<string, number> = {}
  recognition.forEach((line, i) => {
    recognisedBefore[line.account_number] = roundOre((recognisedBefore[line.account_number] ?? 0) + before[i])
  })

  return { ok: true, description, lines, paidAfter, settles, recognisedBefore }
}
