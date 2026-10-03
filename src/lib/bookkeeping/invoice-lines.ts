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
import { buildCurrencyMetadata, resolveSekAmountOrNull } from './currency-utils'
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
import { oreRoundingLine, oreSettlementResidual } from './ore-rounding'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import { cashProRataUnsupportedReason, type CashProRataUnsupportedReason } from './booking-mode'
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
 *   Debit  1510 Kundfordringar     [total incl VAT, minus ROT/RUT]
 *   Debit  1513 Skatteverket       [ROT/RUT per item]
 *   Credit 30xx Försäljning        [subtotal per rate and account]
 *   Credit 26xx Utgående moms      [vat per rate]
 *
 * numberOverride replaces the invoice number in the line texts (self-billing
 * received books under the counterparty's external number).
 */
export function buildInvoiceRegistrationLines(
  invoice: InvoiceRegistrationLinesSource,
  entityType: EntityType,
  numberOverride?: string | null,
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
      // flows), so deferring to 29xx here is safe.
      { deferAccruals: true, defaultDimensions, goodsDeliveryCountry: invoice.delivery_country }
    ))
  } else {
    // Fallback: no items available, use invoice-level amounts. Strict
    // conversion: a rate-less foreign header must refuse exactly like the
    // item-driven path, not post the raw foreign number as kronor.
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
      if (isForeign) {
        const vatSek = headerToSekOrThrow(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate)
        const vatAccount = getOutputVatAccount(invoice.vat_treatment)
        creditLines.push({
          account_number: vatAccount,
          debit_amount: 0,
          credit_amount: vatSek,
          line_description: `Utgående moms faktura ${tag}`,
          dimensions: defaultDimensions,
        })
      } else {
        const vatLines = generateSalesVatLines({
          vatTreatment: invoice.vat_treatment,
          baseAmount: invoice.subtotal,
          direction: 'sales',
        })
        creditLines.push(...vatLines.map((line) => ({
          ...line,
          dimensions: defaultDimensions,
        })))
      }
    }
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
  const arAmount = Math.round((debitAmount - rotRut.totalSek) * 100) / 100

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

  return lines
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
 * originalVoucherRef (e.g. "A-42") is embedded in the line texts: BFL 5 kap.
 * 5 § requires a correction to point back to the corrected verifikation.
 */
export function buildCreditNoteLines(
  creditNote: InvoiceRegistrationLinesSource,
  entityType: EntityType,
  originalVoucherRef?: string,
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const tag = invoiceTag(creditNote)
  const lineSuffix = originalVoucherRef ? ` (avser ${originalVoucherRef})` : ''
  // Dimensions PR7: the credit note's bag (copied from the original at credit
  // time) so the reversal nets against the same dimension cells in reports.
  const defaultDimensions = coerceDimensionsBag(creditNote.default_dimensions)

  // Generate reversed revenue + VAT lines per rate group (debit side for credit notes)
  const debitLines: CreateJournalEntryLineInput[] = []

  if (creditNote.items && creditNote.items.length > 0) {
    // Use absolute items for generatePerRateLines, then swap debit/credit
    const creditLines = generatePerRateLines(
      creditNote.items, creditNote.vat_treatment, entityType, tag,
      creditNote.currency, creditNote.exchange_rate,
      // Credit-note items carry the original's accrual fields so the reversal
      // hits the same 29xx interim account; the original's schedule is
      // cancelled/stornoed by the credit flow. delivery_country is copied
      // from the original too, so goods revenue reverses on 3105 / 3108.
      { deferAccruals: true, defaultDimensions, goodsDeliveryCountry: creditNote.delivery_country }
    )
    // Every caller hands us items negated with -Math.abs (build-credit-note-
    // item.ts), so generatePerRateLines lands every line on the debit side
    // via creditNatural. Taking |net| as the debit reproduces the pre-existing
    // output exactly (the old column swap would now flip them back). Known
    // gap, unchanged by this commit: an original with a NEGATIVE row (rabatt,
    // avrundning) is credited on the same side as the original instead of
    // the opposite one, because -Math.abs erases the row's sign upstream.
    for (const line of creditLines) {
      debitLines.push({
        ...line,
        debit_amount: Math.round(Math.abs(line.credit_amount - line.debit_amount) * 100) / 100,
        credit_amount: 0,
        line_description: `Kreditfaktura ${tag}${lineSuffix}`,
      })
    }
  } else {
    // Fallback: invoice-level amounts. Same strict conversion as the
    // registration fallback above: a rate-less foreign credit note must
    // refuse, not reverse the receivable with a mislabelled number.
    const revenueAccount = getRevenueAccount(creditNote.vat_treatment, entityType, creditNote.delivery_country)
    const absSubtotal = Math.abs(headerToSekOrThrow(creditNote.subtotal, creditNote.subtotal_sek, creditNote.currency, creditNote.exchange_rate))
    const absVat = Math.abs(headerToSekOrThrow(creditNote.vat_amount, creditNote.vat_amount_sek, creditNote.currency, creditNote.exchange_rate))

    debitLines.push({
      account_number: revenueAccount,
      debit_amount: absSubtotal,
      credit_amount: 0,
      line_description: `Kreditfaktura ${tag}`,
      dimensions: defaultDimensions,
    })

    if (absVat > 0) {
      const vatAccount = getOutputVatAccount(creditNote.vat_treatment)
      debitLines.push({
        account_number: vatAccount,
        debit_amount: absVat,
        credit_amount: 0,
        line_description: `Moms kreditfaktura ${tag}${lineSuffix}`,
        dimensions: defaultDimensions,
      })
    }
  }

  lines.push(...debitLines)

  // ROT/RUT reverses the exact receivable split used by the original invoice:
  // 1510 for the customer portion and 1513 for the Skatteverket portion.
  const rotRut = creditNote.items && creditNote.items.length > 0
    ? generateRotRutLines(
        creditNote.items,
        tag,
        creditNote.currency,
        creditNote.exchange_rate,
        defaultDimensions,
        'credit',
      )
    : { lines: [], totalSek: 0 }

  // Credit: Kundfordringar, balance guarantee: 1510 + 1513 equals debits.
  const totalDebits = debitLines.reduce((sum, l) => sum + l.debit_amount, 0)
  const customerReceivable = roundOre(totalDebits - rotRut.totalSek)
  lines.push({
    account_number: '1510',
    debit_amount: 0,
    credit_amount: customerReceivable,
    line_description: `Kreditfaktura ${tag}`,
    dimensions: defaultDimensions,
  })
  lines.push(...rotRut.lines)

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
}

/**
 * The SEK that arrived on the bank row a kontantmetoden payment is matched
 * to, for buildInvoiceCashLines' `knownBankSek`. Undefined unless the row is
 * in SEK: öresavrundning is a whole-krona rule, and a foreign row settles
 * with a kursdiff instead. One derivation for the match route, its preview
 * and createInvoiceCashEntry, so what the dialog shows is what gets booked.
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

  // Fallback: invoice-level amounts. Strict conversion, same rationale as
  // the createInvoiceJournalEntry fallback above.
  const creditLines: CreateJournalEntryLineInput[] = []
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

  return creditLines
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
 *   Debit  1513 Skatteverket        [ROT/RUT deduction]  (if applicable)
 *   Credit 30xx Försäljning         [subtotal per rate]
 *   Credit 26xx Utgående moms       [vat per rate]  (if applicable)
 *   Dr/Cr  3740 Öresavrundning      [bank vs share gap]  (if applicable)
 *
 * `knownBankSek`: the SEK that actually arrived (invoiceCashBankSek), when
 * the payment is matched to a bank row. On a SEK invoice a gap under one
 * krona to the customer share is öresavrundning: 1930 takes what arrived and
 * 3740 the gap (customer side of oreRoundingLine), so 1930 follows the bank
 * statement. Revenue and moms stay on the invoice amounts: 3740 carries no
 * VAT. An exact row, a gap of a krona or more (the routes refuse those
 * before booking) and a foreign invoice book the customer share as before.
 */
export function buildInvoiceCashLines(
  invoice: InvoiceCashLinesSource,
  entityType: EntityType,
  customerName?: string,
  settlementAccountNumber: string = '1930',
  knownBankSek?: number,
): { description: string; lines: CreateJournalEntryLineInput[] } {
  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = invoice.currency !== 'SEK'
  const tag = invoiceTag(invoice)
  // Dimensions PR7: kontantmetoden books revenue at payment, so this IS the
  // producer path for cash-method companies: same merge rules as issuance.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // Credit lines: revenue + VAT per rate group (compute first to guarantee balance)
  const creditLines = cashRecognitionLines(invoice, entityType, tag, defaultDimensions)

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
  const customerShare = roundOre(cashDebit - rotRut.totalSek)
  const oreGap = !isForeign && customerShare > 0 && knownBankSek != null && knownBankSek > 0
    ? oreSettlementResidual(customerShare, knownBankSek)
    : 0
  const bankAmount = roundOre(customerShare - oreGap)
  lines.push({
    account_number: settlementAccountNumber,
    debit_amount: bankAmount,
    credit_amount: 0,
    line_description: buildInvoiceDescription('Kontantbetalning kundfaktura', invoice.invoice_number, customerName, invoice.id),
    dimensions: defaultDimensions,
  })

  lines.push(...rotRut.lines)
  lines.push(...creditLines)
  if (oreGap !== 0) {
    lines.push({ ...oreRoundingLine(oreGap, 'customer'), dimensions: defaultDimensions })
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
  customerName?: string,
  settlementAccountNumber: string = '1930',
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
    settles ? 'Kontant slutbetalning kundfaktura' : 'Kontant delbetalning kundfaktura',
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
