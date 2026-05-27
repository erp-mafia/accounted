import { createJournalEntry, findFiscalPeriod } from './engine'
import { resolveSekAmount, buildCurrencyMetadata } from './currency-utils'
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
 * fallback is defensive — but it leaves no ambiguity if a future caller skips
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
 */
function generatePerRateLines(
  items: InvoiceItem[],
  invoiceVatTreatment: VatTreatment,
  entityType: EntityType,
  invoiceTagText: string,
  currency?: string | null,
  exchangeRate?: number | null
): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = currency != null && currency !== 'SEK'

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
    // Legacy fallback: single rate from invoice level
    const revenueAccount = getRevenueAccount(invoiceVatTreatment, entityType)
    const subtotal = items.reduce((sum, item) => sum + item.line_total, 0)
    const subtotalSek = toSek(subtotal)
    lines.push({
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: subtotalSek,
      line_description: `Försäljning faktura ${invoiceTagText}`,
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
        })
      } else {
        const vatLines = generateSalesVatLines({
          vatTreatment: invoiceVatTreatment,
          baseAmount: subtotal,
          direction: 'sales',
        })
        lines.push(...vatLines)
      }
    }
    return lines
  }

  // Group items by vat_rate
  const rateGroups = new Map<number, { subtotal: number; vatAmount: number }>()
  for (const item of items) {
    const rate = item.vat_rate ?? 0
    const group = rateGroups.get(rate) || { subtotal: 0, vatAmount: 0 }
    group.subtotal += item.line_total
    group.vatAmount += item.vat_amount || 0
    rateGroups.set(rate, group)
  }

  // Generate revenue + VAT lines per rate group
  for (const [rate, group] of rateGroups) {
    const treatment = rate === 0 && (invoiceVatTreatment === 'reverse_charge' || invoiceVatTreatment === 'export')
      ? invoiceVatTreatment
      : getVatTreatmentForRate(rate)
    const revenueAccount = getRevenueAccount(treatment, entityType)
    const roundedSubtotal = Math.round(toSek(group.subtotal) * 100) / 100

    lines.push({
      account_number: revenueAccount,
      debit_amount: 0,
      credit_amount: roundedSubtotal,
      line_description: `Försäljning faktura ${invoiceTagText}`,
    })

    const roundedVat = Math.round(toSek(group.vatAmount) * 100) / 100
    if (roundedVat !== 0) {
      const vatAccount = getOutputVatAccount(treatment)
      lines.push({
        account_number: vatAccount,
        debit_amount: 0,
        credit_amount: roundedVat,
        line_description: `Utgående moms ${rate}% faktura ${invoiceTagText}`,
      })
    }
  }

  return lines
}

/**
 * Generate ROT/RUT-avdrag debit lines from invoice items.
 *
 * For each item flagged with `deduction_type`, produces a debit on BAS 1513
 * (Övriga kortfristiga fordringar — Skatteverket) for the computed
 * deduction amount. The caller must REDUCE the 1510 debit (kundfordringar)
 * by the same total — the customer only owes the post-deduction amount;
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
  customerName?: string
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, invoice.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for invoice date:', invoice.invoice_date)
    return null
  }

  const lines: CreateJournalEntryLineInput[] = []
  const isForeign = invoice.currency !== 'SEK'
  const tag = invoiceTag(invoice)

  // Credit lines: revenue + VAT per rate group (compute first to guarantee balance)
  const creditLines: CreateJournalEntryLineInput[] = []

  if (invoice.items && invoice.items.length > 0) {
    creditLines.push(...generatePerRateLines(
      invoice.items, invoice.vat_treatment, entityType, tag,
      invoice.currency, invoice.exchange_rate
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
        })
      } else {
        const vatLines = generateSalesVatLines({
          vatTreatment: invoice.vat_treatment,
          baseAmount: invoice.subtotal,
          direction: 'sales',
        })
        creditLines.push(...vatLines)
      }
    }
  }

  // ROT/RUT-avdrag debit lines (1513 Skatteverket). When present, they
  // reduce the 1510 debit by the same total so the verifikation stays
  // balanced (debits 1510 + 1513 = credits revenue + VAT). The customer
  // only owes the post-deduction amount; Skatteverket pays the rest.
  const rotRut = invoice.items && invoice.items.length > 0
    ? generateRotRutLines(invoice.items, tag, invoice.currency, invoice.exchange_rate)
    : { lines: [], totalSek: 0 }

  // Debit: Kundfordringar — balance guarantee: debit = sum of all credit
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
    ...buildCurrencyMetadata(invoice.currency, isForeign ? invoice.total : undefined, invoice.exchange_rate),
  })

  lines.push(...rotRut.lines)
  lines.push(...creditLines)

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: invoice.invoice_date,
    description: buildInvoiceDescription('Kundfaktura', invoice.invoice_number, customerName, invoice.id),
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

  // Generate reversed revenue + VAT lines per rate group (debit side for credit notes)
  const debitLines: CreateJournalEntryLineInput[] = []

  if (creditNote.items && creditNote.items.length > 0) {
    // Use absolute items for generatePerRateLines, then swap debit/credit
    const creditLines = generatePerRateLines(
      creditNote.items, creditNote.vat_treatment, entityType, tag,
      creditNote.currency, creditNote.exchange_rate
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
    })

    if (absVat > 0) {
      const vatAccount = getOutputVatAccount(creditNote.vat_treatment)
      debitLines.push({
        account_number: vatAccount,
        debit_amount: absVat,
        credit_amount: 0,
        line_description: `Moms kreditfaktura ${tag}${lineSuffix}`,
      })
    }
  }

  lines.push(...debitLines)

  // Credit: Kundfordringar — balance guarantee: credit = sum of all debit lines
  const totalDebits = debitLines.reduce((sum, l) => sum + l.debit_amount, 0)
  lines.push({
    account_number: '1510',
    debit_amount: 0,
    credit_amount: Math.round(totalDebits * 100) / 100,
    line_description: `Kreditfaktura ${tag}`,
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

  // Credit lines: revenue + VAT per rate group (compute first to guarantee balance)
  const creditLines: CreateJournalEntryLineInput[] = []

  if (invoice.items && invoice.items.length > 0) {
    creditLines.push(...generatePerRateLines(
      invoice.items, invoice.vat_treatment, entityType, tag,
      invoice.currency, invoice.exchange_rate
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
    })

    if (invoice.vat_amount > 0) {
      const vatSek = resolveSekAmount(invoice.vat_amount, invoice.vat_amount_sek, invoice.currency, invoice.exchange_rate)
      const vatAccount = getOutputVatAccount(invoice.vat_treatment)
      creditLines.push({
        account_number: vatAccount,
        debit_amount: 0,
        credit_amount: vatSek,
        line_description: `Utgående moms faktura ${tag}`,
      })
    }
  }

  // ROT/RUT-avdrag debit lines (1513 Skatteverket). On cash method the
  // bank account (1930) receives only the post-deduction amount in real
  // life; the rest comes from Skatteverket later. We model that by
  // splitting the debit: 1930 = total - deduction, 1513 = deduction.
  const rotRut = invoice.items && invoice.items.length > 0
    ? generateRotRutLines(invoice.items, tag, invoice.currency, invoice.exchange_rate)
    : { lines: [], totalSek: 0 }

  // Debit: Företagskonto — balance guarantee: debit = sum of credit lines
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
