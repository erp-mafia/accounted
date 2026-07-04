import { createJournalEntry, findFiscalPeriod } from './engine'
import { resolveSekAmount, buildCurrencyMetadata } from './currency-utils'
import { resolveBookingAccount } from './accruals/account-suggestions'
import {
  coerceDimensionsBag,
  dimensionsBagKey,
  mergeDimensionBags,
  type LineDimensions,
} from './dimension-resolver'
import { generateSalesVatLines } from './vat-entries'
import { getVatTreatmentForRate } from '@/lib/invoices/vat-rules'
import { computeDeduction } from '@/lib/invoices/rot-rut-rules'
import { createLogger } from '@/lib/logger'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  CreateJournalEntryLineInput,
  EntityType,
  Invoice,
  InvoiceItem,
  JournalEntry,
  VatTreatment,
} from '@/types'

const log = createLogger('invoice-entries')

/**
 * Build the invoice identifier used in line_description. Prefers the assigned
 * invoice number; falls back to a draft tag with the first 8 chars of the
 * invoice UUID so the verifikation still identifies *vad affärshändelsen avser*
 * per BFL 5 kap 6§ p.3 even if a journal entry is somehow created against an
 * unnumbered invoice. The send path always assigns a number first, so this
 * fallback is defensive, but it leaves no ambiguity if a future caller skips
 * ensureInvoiceNumber.
 */
function invoiceTag(invoice: Pick<Invoice, 'id' | 'invoice_number'>): string {
  return invoice.invoice_number ?? `utkast ${invoice.id.slice(0, 8)}`
}

/**
 * Build a BFL-compliant verifikation description with event type and counterparty.
 * Falls back to prefix + invoiceNumber if name is not provided (backward compat).
 */
function buildInvoiceDescription(
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
 */
function generatePerRateLines(
  items: InvoiceItem[],
  invoiceVatTreatment: VatTreatment,
  entityType: EntityType,
  invoiceTagText: string,
  currency?: string | null,
  exchangeRate?: number | null,
  options?: { deferAccruals?: boolean; defaultDimensions?: LineDimensions }
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = currency != null && currency !== 'SEK'

  // Free-text / blank rows carry no amounts and never book: drop them before
  // grouping so they can't produce a zero-amount revenue line.
  items = items.filter((item) => item.line_type !== 'text')

  // Helper: convert item amount to SEK when dealing with foreign currency
  const toSek = (amount: number): number => {
    if (!isForeign) return amount
    if (exchangeRate != null && exchangeRate > 0) {
      return Math.round(amount * exchangeRate * 100) / 100
    }
    return amount // fallback for legacy data
  }

  // Check if items have per-line vat_rate set (new invoices)
  const hasPerLineVat = items.some((item) => item.vat_rate !== undefined && item.vat_rate !== null)

  if (!hasPerLineVat) {
    // Legacy fallback: single rate from invoice level. All items collapse
    // into one revenue line, so only the invoice default can apply here:
    // legacy rows predate per-item tagging anyway.
    const revenueAccount = getRevenueAccount(invoiceVatTreatment, entityType)
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
    // reverse_charge / export force the statutory revenue account (3308/3305);
    // a per-line override only applies to ordinary domestic rates so EU/export
    // sales keep landing in the right VAT-declaration ruta.
    const isSpecialTreatment = treatment === 'reverse_charge' || treatment === 'export'
    const plAccount = !isSpecialTreatment && item.revenue_account
      ? item.revenue_account
      : getRevenueAccount(treatment, entityType)
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
      lines.push({
        account_number: bucket.account,
        debit_amount: 0,
        credit_amount: credit,
        line_description: `Försäljning faktura ${invoiceTagText}`,
        dimensions: bucket.dimensions,
      })
    })

    const roundedVat = Math.round(toSek(group.vatAmount) * 100) / 100
    if (roundedVat !== 0) {
      const vatAccount = getOutputVatAccount(treatment)
      lines.push({
        account_number: vatAccount,
        debit_amount: 0,
        credit_amount: roundedVat,
        line_description: `Utgående moms ${rate}% faktura ${invoiceTagText}`,
        dimensions: options?.defaultDimensions,
      })
    }
  }

  return lines
}

/**
 * Generate ROT/RUT-avdrag debit lines from invoice items.
 *
 * For each item flagged with `deduction_type`, produces a debit on BAS 1513
 * (Övriga kortfristiga fordringar, Skatteverket) for the computed
 * deduction amount. The caller must REDUCE the 1510 debit (kundfordringar)
 * by the same total: the customer only owes the post-deduction amount;
 * Skatteverket pays the rest via Husavdragstjänsten. Returns both the
 * lines and the total so callers can apply both adjustments atomically.
 *
 * Foreign-currency invoices: ROT/RUT-avdrag is a Sweden-only rule, so
 * receivables on 1513 are always recorded in SEK. We use the same SEK
 * conversion as the rest of the entry (toSek closure logic on the caller
 * side reproduced here for parity with generatePerRateLines).
 */
function generateRotRutLines(
  items: InvoiceItem[],
  invoiceTagText: string,
  currency?: string | null,
  exchangeRate?: number | null,
  defaultDimensions?: LineDimensions,
): { lines: CreateJournalEntryLineInput[]; totalSek: number } {
  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = currency != null && currency !== 'SEK'

  const toSek = (amount: number): number => {
    if (!isForeign) return amount
    if (exchangeRate != null && exchangeRate > 0) {
      return Math.round(amount * exchangeRate * 100) / 100
    }
    return amount
  }

  let totalSek = 0

  for (const item of items) {
    if (!item.deduction_type) continue
    // Recompute server-side to defend against tampered client values.
    const amount = computeDeduction({
      unit_price: item.unit_price,
      quantity: item.quantity,
      deduction_type: item.deduction_type,
    })
    if (amount <= 0) continue
    const amountSek = Math.round(toSek(amount) * 100) / 100
    if (amountSek <= 0) continue
    totalSek += amountSek
    const kind = item.deduction_type === 'rot' ? 'ROT' : 'RUT'
    lines.push({
      account_number: '1513',
      debit_amount: amountSek,
      credit_amount: 0,
      line_description: `${kind}-avdrag faktura ${invoiceTagText}`,
      // Per-item line: carries the item's merged bag like its revenue line.
      dimensions: mergeDimensionBags(defaultDimensions, item.dimensions),
    })
  }

  return { lines, totalSek: Math.round(totalSek * 100) / 100 }
}

/**
 * Create journal entry when an invoice is created (status != draft)
 *
 * Supports mixed VAT rates per line item. Groups items by vat_rate
 * and creates separate revenue + VAT lines per rate.
 *
 * Standard domestic invoice (25% VAT):
 *   Debit  1510 Kundfordringar     [total incl VAT]
 *   Credit 30xx Försäljning         [subtotal per rate]
 *   Credit 26xx Utgående moms       [vat per rate]
 *
 * EU reverse charge:
 *   Debit  1510 Kundfordringar     [subtotal]
 *   Credit 3308 Försäljning tjänst EU [subtotal]
 *
 * Export (non-EU):
 *   Debit  1510 Kundfordringar     [subtotal]
 *   Credit 3305 Försäljning tjänst Export [subtotal]
 */
export async function createInvoiceJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  entityType: EntityType = 'enskild_firma',
  customerName?: string,
  /**
   * Overrides for non-standard sales that still book identically to a customer
   * invoice. Used by self-billing received (mottagen självfaktura): the
   * verifikation should read "Självfaktura <external number>" rather than
   * "Kundfaktura <our number>", and the number tag must be the counterparty's
   * external number because the row has no own `invoice_number`.
   */
  options?: { descriptionPrefix?: string; numberOverride?: string | null }
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, invoice.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for invoice date:', invoice.invoice_date)
    return null
  }

  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = invoice.currency !== 'SEK'
  const tag = options?.numberOverride ?? invoiceTag(invoice)
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
      { deferAccruals: true, defaultDimensions }
    ))
  } else {
    // Fallback: no items available, use invoice-level amounts
    const revenueAccount = getRevenueAccount(invoice.vat_treatment, entityType)
    const subtotalSek = resolveSekAmount(invoice.subtotal, invoice.subtotal_sek, invoice.currency, invoice.exchange_rate)

    creditLines.push({
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: subtotalSek,
      line_description: `Försäljning faktura ${tag}`,
      dimensions: defaultDimensions,
    })

    if (invoice.vat_amount > 0) {
      if (isForeign) {
        const vatSek = resolveSekAmount(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate)
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

  // Debit: Kundfordringar, balance guarantee: debit = sum of all credit
  // lines MINUS the ROT/RUT total which goes to 1513 instead.
  const totalCredits = creditLines.reduce((sum, l) => sum + l.credit_amount, 0)
  const debitAmount = isForeign
    ? Math.round(totalCredits * 100) / 100
    : resolveSekAmount(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
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

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: invoice.invoice_date,
    description: buildInvoiceDescription(
      options?.descriptionPrefix ?? 'Kundfaktura',
      options?.numberOverride ?? invoice.invoice_number,
      customerName,
      invoice.id,
    ),
    source_type: 'invoice_created',
    source_id: invoice.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create journal entry when an invoice is marked as paid
 *
 *   Debit  1930 Företagskonto       [total]
 *   Credit 1510 Kundfordringar      [total]
 */
export async function createInvoicePaymentJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  paymentDate: string,
  exchangeRateDifference?: number,
  customerName?: string,
  paymentAmount?: number
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  const isPartial = paymentAmount != null
  const desc = buildInvoiceDescription(
    isPartial ? 'Delbetalning kundfaktura' : 'Inbetalning kundfaktura',
    invoice.invoice_number,
    customerName,
    invoice.id,
  )
  // Dimensions PR7: the payment voucher re-propagates the linked invoice's
  // default bag onto every leg: incl. the FX result lines, so a project's
  // kursvinst/kursförlust stays inside the project P&L.
  const defaultDimensions = coerceDimensionsBag(invoice.default_dimensions)

  // When paymentAmount is provided, use it for the 1930/1510 line amounts.
  // Otherwise use the full invoice total (backward compatible).
  const bookedSekAmount = isPartial
    ? resolveSekAmount(paymentAmount, null, invoice.currency, invoice.exchange_rate)
    : resolveSekAmount(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)

  const lines: CreateJournalEntryLineInput[] = []

  if (!isPartial && exchangeRateDifference && exchangeRateDifference !== 0) {
    // Foreign currency with exchange rate difference
    // For receivables: positive diff = gain (received more), negative = loss (received less)
    const actualSekReceived = bookedSekAmount + exchangeRateDifference

    // Debit: Bank at actual SEK received
    lines.push({
      account_number: '1930',
      debit_amount: Math.round(actualSekReceived * 100) / 100,
      credit_amount: 0,
      line_description: desc,
    })

    // Credit: Clear kundfordringar at original booked SEK amount
    lines.push({
      account_number: '1510',
      debit_amount: 0,
      credit_amount: Math.round(bookedSekAmount * 100) / 100,
      line_description: desc,
    })

    // Exchange rate difference
    if (exchangeRateDifference > 0) {
      // Gain: Credit 3960 (received more than booked)
      lines.push({
        account_number: '3960',
        debit_amount: 0,
        credit_amount: Math.round(exchangeRateDifference * 100) / 100,
        line_description: 'Valutakursvinst',
      })
    } else {
      // Loss: Debit 7960 (received less than booked)
      lines.push({
        account_number: '7960',
        debit_amount: Math.round(Math.abs(exchangeRateDifference) * 100) / 100,
        credit_amount: 0,
        line_description: 'Valutakursförlust',
      })
    }
  } else {
    // Standard SEK payment or no exchange rate difference
    lines.push(
      {
        account_number: '1930',
        debit_amount: Math.round(bookedSekAmount * 100) / 100,
        credit_amount: 0,
        line_description: desc,
      },
      {
        account_number: '1510',
        debit_amount: 0,
        credit_amount: Math.round(bookedSekAmount * 100) / 100,
        line_description: desc,
      }
    )
  }

  if (defaultDimensions) {
    // Copy per line: a shared bag object would let one line's mutation
    // leak into every other line (same contract as proposal stamping).
    for (const line of lines) line.dimensions = { ...defaultDimensions }
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description: desc,
    source_type: 'invoice_paid',
    source_id: invoice.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create journal entry for a credit note (reversed version of original invoice entry)
 * Supports per-item VAT rates with reversed debit/credit sides.
 *
 *   Debit  30xx Försäljning         [subtotal per rate]
 *   Debit  26xx Utgående moms       [vat per rate]
 *   Credit 1510 Kundfordringar      [total]
 */
export async function createCreditNoteJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  creditNote: Invoice,
  entityType: EntityType = 'enskild_firma',
  customerName?: string,
  /**
   * Original voucher reference (e.g. "A-42") to embed in the JE description and
   * line-level descriptions. BFL 5 kap. 5 § requires a correction to point back
   * to the corrected verifikation; the invoice number alone is insufficient
   * because it doesn't identify the entry in the verifikationsserie.
   */
  originalVoucherRef?: string
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, creditNote.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for credit note date:', creditNote.invoice_date)
    return null
  }

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
      // cancelled/stornoed by the credit flow.
      { deferAccruals: true, defaultDimensions }
    )
    for (const line of creditLines) {
      debitLines.push({
        ...line,
        debit_amount: Math.abs(line.credit_amount),
        credit_amount: Math.abs(line.debit_amount),
        line_description: `Kreditfaktura ${tag}${lineSuffix}`,
      })
    }
  } else {
    // Fallback: invoice-level amounts
    const revenueAccount = getRevenueAccount(creditNote.vat_treatment, entityType)
    const absSubtotal = Math.abs(resolveSekAmount(creditNote.subtotal, creditNote.subtotal_sek, creditNote.currency, creditNote.exchange_rate))
    const absVat = Math.abs(resolveSekAmount(creditNote.vat_amount, creditNote.vat_amount_sek, creditNote.currency, creditNote.exchange_rate))

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

  // Credit: Kundfordringar, balance guarantee: credit = sum of all debit lines
  const totalDebits = debitLines.reduce((sum, l) => sum + l.debit_amount, 0)
  lines.push({
    account_number: '1510',
    debit_amount: 0,
    credit_amount: Math.round(totalDebits * 100) / 100,
    line_description: `Kreditfaktura ${tag}`,
    dimensions: defaultDimensions,
  })

  const baseDescription = buildInvoiceDescription('Kreditfaktura', creditNote.invoice_number, customerName, creditNote.id)
  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: creditNote.invoice_date,
    description: originalVoucherRef
      ? `${baseDescription} (avser verifikation ${originalVoucherRef})`
      : baseDescription,
    source_type: 'credit_note',
    source_id: creditNote.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Create journal entry for kontantmetoden (cash method) when payment is received.
 * Supports per-item VAT rates. Revenue + VAT recognised at payment.
 *
 *   Debit  1930 Företagskonto       [total]
 *   Credit 30xx Försäljning         [subtotal per rate]
 *   Credit 26xx Utgående moms       [vat per rate]  (if applicable)
 */
export async function createInvoiceCashEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  paymentDate: string,
  entityType: EntityType = 'enskild_firma',
  customerName?: string
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

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
      { defaultDimensions }
    ))
  } else {
    // Fallback: invoice-level amounts
    const revenueAccount = getRevenueAccount(invoice.vat_treatment, entityType)
    const subtotalSek = resolveSekAmount(invoice.subtotal, invoice.subtotal_sek, invoice.currency, invoice.exchange_rate)

    creditLines.push({
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: subtotalSek,
      line_description: `Försäljning faktura ${tag}`,
      dimensions: defaultDimensions,
    })

    if (invoice.vat_amount > 0) {
      const vatSek = resolveSekAmount(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate)
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
  const totalCredits = creditLines.reduce((sum, l) => sum + l.credit_amount, 0)
  const cashDebit = isForeign
    ? Math.round(totalCredits * 100) / 100
    : resolveSekAmount(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
  const bankAmount = Math.round((cashDebit - rotRut.totalSek) * 100) / 100
  lines.push({
    account_number: '1930',
    debit_amount: bankAmount,
    credit_amount: 0,
    line_description: buildInvoiceDescription('Kontantbetalning kundfaktura', invoice.invoice_number, customerName, invoice.id),
    dimensions: defaultDimensions,
  })

  lines.push(...rotRut.lines)
  lines.push(...creditLines)

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description: buildInvoiceDescription('Kontantbetalning kundfaktura', invoice.invoice_number, customerName, invoice.id),
    source_type: 'invoice_cash_payment',
    source_id: invoice.id,
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

/**
 * Get the appropriate revenue account based on VAT treatment
 *
 * For 'exempt': AB uses 3004 (Försäljning inom Sverige, momsfri),
 * EF uses 3100 (Momsfria intäkter, mapped to R2 in NE engine).
 */
export function getRevenueAccount(vatTreatment: VatTreatment, entityType: EntityType = 'enskild_firma'): string {
  switch (vatTreatment) {
    case 'standard_25':
      return '3001' // Försäljning 25%
    case 'reduced_12':
      return '3002' // Försäljning 12%
    case 'reduced_6':
      return '3003' // Försäljning 6%
    case 'reverse_charge':
      return '3308' // Försäljning tjänst EU
    case 'export':
      return '3305' // Försäljning tjänst Export
    case 'exempt':
      return entityType === 'aktiebolag' ? '3004' : '3100'
    default:
      return '3001'
  }
}

/**
 * Get the output VAT account based on VAT treatment
 */
export function getOutputVatAccount(vatTreatment: VatTreatment): string {
  switch (vatTreatment) {
    case 'standard_25':
      return '2611'
    case 'reduced_12':
      return '2621'
    case 'reduced_6':
      return '2631'
    default:
      return '2611'
  }
}
