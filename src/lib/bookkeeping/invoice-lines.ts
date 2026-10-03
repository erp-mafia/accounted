/**
 * The pure line builders of the customer-invoice verifikat: per-rate revenue
 * and moms lines, the skattereduktion (1513) lines, and the whole
 * kontantmetoden payment entry (buildInvoiceCashLines).
 *
 * No engine, Supabase or logger import, so the browser can run them: the
 * payment dialog proposes the kontantmetoden entry with buildInvoiceCashLines
 * itself instead of a hand-kept copy that had drifted from it (it credited the
 * rate's default account where the invoice line named its own). The engine
 * wrappers that book these lines stay in ./invoice-entries.
 */
import { resolveSekAmountOrNull } from './currency-utils'
import { resolveBookingAccount } from './accruals/account-suggestions'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  mergeDimensionBags,
  type LineDimensions,
} from './dimension-resolver'
import { generateSalesVatLines } from './vat-entries'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
import { computeDeduction, DEDUCTION_TYPE_LABELS } from '@/lib/invoices/rot-rut-rules'
import { creditNatural } from './line-side'
import { InvoiceFxRateMissingError, getOutputVatAccount, getRevenueAccount } from './invoice-accounts'
import type {
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
  const isForeign = currency != null && currency !== 'SEK'

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
    const revenueAccount = getRevenueAccount(invoiceVatTreatment, entityType, goodsDeliveryCountry)
    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0)
    const subtotalSek = toSek(subtotal)
    lines.push({
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: subtotalSek,
      line_description: `Försäljning faktura ${invoiceTagText}`,
      dimensions: options?.defaultDimensions,
    })

    const totalVat = items.reduce((sum, item) => sum + (item.vat_amount || 0), 0)
    if (totalVat > 0) {
      if (isForeign) {
        // For foreign currency, compute VAT in SEK directly
        const vatSek = toSek(totalVat)
        const vatAccount = getOutputVatAccount(invoiceVatTreatment)
        lines.push({
          account_number: vatAccount,
          debit_amount: 0,
          credit_amount: vatSek,
          line_description: `Utgående moms faktura ${invoiceTagText}`,
          dimensions: options?.defaultDimensions,
        })
      } else {
        const vatLines = generateSalesVatLines({
          vatTreatment: invoiceVatTreatment,
          baseAmount: subtotal,
          direction: 'sales',
        })
        lines.push(...vatLines.map((line) => ({
          ...line,
          dimensions: options?.defaultDimensions,
        })))
      }
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
    const treatment = rate === 0 && (invoiceVatTreatment === 'reverse_charge' || invoiceVatTreatment === 'export')
      ? invoiceVatTreatment
      : getVatTreatmentForRate(rate)
    // reverse_charge / export force the statutory revenue account (3308/3305,
    // or 3108/3105 for goods delivered abroad); a per-line override only
    // applies to ordinary domestic rates so EU/export sales keep landing in
    // the right VAT-declaration ruta.
    const isSpecialTreatment = treatment === 'reverse_charge' || treatment === 'export'
    const plAccount = !isSpecialTreatment && item.revenue_account
      ? item.revenue_account
      : getRevenueAccount(treatment, entityType, goodsDeliveryCountry)
    // Periodiserade lines credit the 29xx interim account (förutbetalda
    // intäkter) instead of revenue; the schedule dissolves it monthly. Output
    // VAT below is untouched. Moms is never deferred. Special treatments are
    // never deferred (ruta 39/40 must reflect the full period's sales).
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
    const treatment = rate === 0 && (invoiceVatTreatment === 'reverse_charge' || invoiceVatTreatment === 'export')
      ? invoiceVatTreatment
      : getVatTreatmentForRate(rate)

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
        line_description: `Försäljning faktura ${invoiceTagText}`,
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
 * Generate skattereduktion (ROT/RUT-avdrag, grön teknik) debit lines from
 * invoice items.
 *
 * For each item flagged with `deduction_type`, produces a debit on BAS 1513
 * (Övriga kortfristiga fordringar, Skatteverket) for the computed
 * deduction amount. The caller must REDUCE the 1510 debit (kundfordringar)
 * by the same total: the customer only owes the post-deduction amount;
 * Skatteverket pays the rest (Husavdragstjänsten for ROT/RUT, the e-tjänst
 * Grön teknik: företag for grön teknik). Revenue and utgående moms stay on
 * the full amount: the reduction is a claim on Skatteverket, not a price
 * reduction. Returns both the lines and the total so callers can apply both
 * adjustments atomically.
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

  for (const item of items) {
    if (!item.deduction_type) continue
    // Recompute server-side to defend against tampered client values.
    const amount = computeDeduction({
      unit_price: side === 'credit' ? Math.abs(item.unit_price) : item.unit_price,
      quantity: side === 'credit' ? Math.abs(item.quantity) : item.quantity,
      // The deduction base is the NET line total (rabatt reduces what the
      // customer pays); omitting this books 1513 on the gross while the
      // stored deduction_total and the Skatteverket claim carry the net.
      discount_percent: item.discount_percent ?? 0,
      deduction_type: item.deduction_type,
      // Grön teknik's rate follows the installation type: the same input the
      // stored deduction_total was computed from.
      work_type: item.work_type,
      vat_rate: item.vat_rate,
    })
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
}

/**
 * The kontantmetoden (cash method) verifikat for a received payment, pure:
 * createInvoiceCashEntry books exactly these lines, and the bank-match
 * preview and the payment dialog (proposePaymentLines) show them, so the
 * rows a user approves or edits carry what gets booked, the invoice's
 * dimensions included. Supports per-item VAT rates. Revenue + VAT
 * recognised at payment.
 *
 *   Debit  1930 Företagskonto       [total]
 *   Credit 30xx Försäljning         [subtotal per rate]
 *   Credit 26xx Utgående moms       [vat per rate]  (if applicable)
 */
export function buildInvoiceCashLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
  customerName?: string,
  settlementAccountNumber: string = '1930',
): { description: string; lines: CreateJournalEntryLineInput[] } {
  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = invoice.currency !== 'SEK'
  const tag = invoiceTag(invoice)
  // Dimensions PR7: kontantmetoden books revenue at payment, so this IS the
  // producer path for cash-method companies: same merge rules as issuance.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Credit lines: revenue + VAT per rate group (compute first to guarantee balance)
  const creditLines: CreateJournalEntryLineInput[] = []

  if (invoice.items && invoice.items.length > 0) {
    creditLines.push(...generatePerRateLines(
      invoice.items, invoice.vat_treatment, entityType, tag,
      invoice.currency, invoice.exchange_rate,
      { defaultDimensions, goodsDeliveryCountry: invoice.delivery_country }
    ))
  } else {
    // Fallback: invoice-level amounts. Strict conversion, same rationale as
    // the createInvoiceJournalEntry fallback above.
    const revenueAccount = getRevenueAccount(invoice.vat_treatment, entityType, invoice.delivery_country)
    const subtotalSek = headerToSekOrThrow(invoice.subtotal, invoice.subtotal_sek, invoice.currency, invoice.exchange_rate)

    creditLines.push({
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: subtotalSek,
      line_description: `Försäljning faktura ${tag}`,
      dimensions: defaultDimensions,
    })

    if (invoice.vat_amount > 0) {
      const vatSek = headerToSekOrThrow(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate)
      const vatAccount = getOutputVatAccount(invoice.vat_treatment)
      creditLines.push({
        account_number: vatAccount,
        debit_amount: 0,
        credit_amount: vatSek,
        line_description: `Utgående moms faktura ${tag}`,
        dimensions: defaultDimensions,
      })
    }
  }

  // ROT/RUT-avdrag debit lines (1513 Skatteverket). On cash method the
  // bank account (1930) receives only the post-deduction amount in real
  // life; the rest comes from Skatteverket later. We model that by
  // splitting the debit: 1930 = total - deduction, 1513 = deduction.
  const rotRut = invoice.items && invoice.items.length > 0
    ? generateRotRutLines(invoice.items, tag, invoice.currency, invoice.exchange_rate, defaultDimensions)
    : { lines: [], totalSek: 0 }

  // Debit: Företagskonto, balance guarantee: debit = sum of credit lines
  // minus the ROT/RUT total which goes to 1513 instead.
  // NET of the revenue/VAT lines: a negative row sits on the debit side.
  const totalCredits = creditLines.reduce((sum, l) => sum + l.credit_amount - l.debit_amount, 0)
  const cashDebit = isForeign
    ? Math.round(totalCredits * 100) / 100
    : headerToSekOrThrow(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
  const bankAmount = Math.round((cashDebit - rotRut.totalSek) * 100) / 100
  lines.push({
    account_number: settlementAccountNumber,
    debit_amount: bankAmount,
    credit_amount: 0,
    line_description: buildInvoiceDescription('Kontantbetalning kundfaktura', invoice.invoice_number, customerName, invoice.id),
    dimensions: defaultDimensions,
  })

  lines.push(...rotRut.lines)
  lines.push(...creditLines)

  return {
    description: buildInvoiceDescription('Kontantbetalning kundfaktura', invoice.invoice_number, customerName, invoice.id),
    lines,
  }
}
