import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import { createJournalEntry, findFiscalPeriod } from './engine'
import { coerceDimensionsBag } from './dimension-resolver'
import { createLogger } from '@/lib/logger'
import { roundOre } from '@/lib/money'
import type { SupabaseClient } from '@supabase/supabase-js'
import type {
  CreateJournalEntryInput,
  Transaction,
  CreateJournalEntryLineInput,
  EntityType,
  Invoice,
  JournalEntry,
} from '@/types'

const log = createLogger('invoice-entries')

// INVOICE_FX_RATE_MISSING, InvoiceFxRateMissingError, getRevenueAccount and
// getOutputVatAccount live in ./invoice-accounts (pure, no engine import):
// the client-side proposal helpers (propose-send-lines, propose-payment-lines)
// need only those, and importing them from here dragged the engine, the
// account backfill and with it the full BAS chart into the browser bundle.
export { getOutputVatAccount, getRevenueAccount } from './invoice-accounts'
// The pure line builders live in ./invoice-lines so the browser can run them
// (the payment dialog proposes the kontantmetoden entry with
// buildInvoiceCashLines, the send dialog the registration or credit-note entry);
// this module keeps the engine wrappers that book them.
import {
  buildCreditNoteLines,
  buildInvoiceCashLines,
  buildInvoiceDescription,
  buildInvoiceRegistrationLines,
  headerToSekOrThrow,
  invoiceCashBankSek,
} from './invoice-lines'
export { buildInvoiceCashLines } from './invoice-lines'

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
   *
   * customLines: user-edited rows from the send dialog. Booked verbatim
   * (caller validates balance); line generation is skipped entirely.
   */
  options?: InvoiceJournalEntryOptions
): Promise<JournalEntry | null> {
  const input = await buildInvoiceJournalEntryInput(supabase, companyId, invoice, entityType, customerName, options)
  if (!input) return null
  return createJournalEntry(supabase, companyId, userId, input)
}

export interface InvoiceJournalEntryOptions {
  descriptionPrefix?: string
  numberOverride?: string | null
  customLines?: CreateJournalEntryLineInput[]
}

/**
 * The verifikat createInvoiceJournalEntry would post, without posting it: the
 * fiscal period lookup is the only database read, and nothing is written. The
 * deferred "Bokför" dry run previews these lines. Returns null when no open
 * fiscal period covers invoice_date. Throws the same generator errors
 * (InvoiceFxRateMissingError) the committing path throws.
 */
export async function buildInvoiceJournalEntryInput(
  supabase: SupabaseClient,
  companyId: string,
  invoice: Invoice,
  entityType: EntityType,
  customerName?: string,
  options?: InvoiceJournalEntryOptions
): Promise<CreateJournalEntryInput | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, invoice.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for invoice date:', invoice.invoice_date)
    return null
  }

  if (options?.customLines && options.customLines.length > 0) {
    return {
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
      lines: options.customLines,
    }
  }

  const lines = buildInvoiceRegistrationLines(invoice, entityType, options?.numberOverride)

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

  return input
}

/**
 * What the customer still owes on an invoice, in invoice currency:
 * remaining_amount when the row carries it, else total minus paid_amount.
 * remaining_amount is written as total minus the ROT/RUT deduction at
 * creation (build-invoice-write.ts) and decremented per payment, so it is the
 * one figure that already knows about both partial payments and the 1513
 * share. Never falls back to the bare total when paid_amount is present.
 */
function invoiceOutstandingAmount(invoice: Invoice): number {
  const inv = invoice as Invoice & {
    remaining_amount?: number | null
    paid_amount?: number | null
    deduction_total?: number | null
    deduction_reclaimed_total?: number | null
  }
  // A payment is being booked, so a stored 0 cannot mean "settled": rows
  // written by paths that bypass buildInvoiceWriteData (imports, sandbox seed,
  // legacy migrations) leave the NOT NULL DEFAULT 0 in place. Treat 0 as
  // unmaintained and derive: total minus prior payments minus the ROT/RUT
  // share that was never the customer's to pay.
  if (typeof inv.remaining_amount === 'number' && Number.isFinite(inv.remaining_amount) && inv.remaining_amount > 0) {
    return roundOre(inv.remaining_amount)
  }
  const paid = typeof inv.paid_amount === 'number' ? inv.paid_amount : 0
  const deduction = typeof inv.deduction_total === 'number' ? inv.deduction_total : 0
  // A refused deduction (rot_rut_reclaim) is the customer's again: same
  // formula as invoiceCustomerShare and the SQL INSERT guard.
  const reclaimed =
    typeof inv.deduction_reclaimed_total === 'number' ? inv.deduction_reclaimed_total : 0
  return roundOre(invoice.total - paid - deduction + reclaimed)
}

/**
 * Create journal entry when an invoice is marked as paid
 *
 *   Debit  1930 Företagskonto       [total]
 *   Credit 1510 Kundfordringar      [total]
 *
 * `settlementAccountNumber` overrides the debit side for payments that land
 * somewhere other than the bank account: e.g. '1686' (Fordringar för
 * kontokort) when a Stripe payment settles into the PSP balance and only
 * reaches 1930 with the later payout.
 */
export async function createInvoicePaymentJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  paymentDate: string,
  exchangeRateDifference?: number,
  customerName?: string,
  paymentAmount?: number,
  settlementAccountNumber: string = '1930',
  bankTransaction?: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>
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
  // Otherwise the payment settles what is still outstanding on the invoice:
  // remaining_amount (total minus prior partial payments minus any ROT/RUT
  // deduction, which sits on 1513 and is never the customer's to pay). Booking
  // invoice.total here, as this path did before, credited 1510 for money that
  // never arrived: 1510 went negative by the avdrag on every ROT/RUT invoice
  // settled through mark-paid without lines, and 1930 was overstated by the
  // same amount. Strict conversion on all three: a rate-less foreign payment
  // would otherwise clear 1510 with the raw foreign number relabelled as
  // kronor (balanced against an equally wrong 1930 debit, so nothing
  // downstream could catch it). A fully outstanding invoice still converts via
  // total_sek exactly as before, so legacy rows without a rate keep working.
  const outstanding = invoiceOutstandingAmount(invoice)
  const settlesFullTotal = Math.abs(outstanding - invoice.total) < 0.005
  const bookedSekAmount = isPartial
    ? headerToSekOrThrow(paymentAmount, null, invoice.currency, invoice.exchange_rate)
    : settlesFullTotal
      ? headerToSekOrThrow(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
      : headerToSekOrThrow(outstanding, null, invoice.currency, invoice.exchange_rate)

  const lines: CreateJournalEntryLineInput[] = []

  if (!isPartial && exchangeRateDifference && exchangeRateDifference !== 0) {
    // Foreign currency with exchange rate difference
    // For receivables: positive diff = gain (received more), negative = loss (received less)
    const actualSekReceived = bookedSekAmount + exchangeRateDifference

    // Debit: settlement account (bank by default) at actual SEK received
    lines.push({
      account_number: settlementAccountNumber,
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
        account_number: settlementAccountNumber,
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
    ...(bankTransaction ? { bank_booking_context: [bankBookingContext(bankTransaction, settlementAccountNumber)] } : {}),
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

  const lines = buildCreditNoteLines(creditNote, entityType, originalVoucherRef)

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
 * Create the journal entry for kontantmetoden (cash method) when payment is
 * received: the lines of buildInvoiceCashLines, booked in the open period of
 * the payment date. Returns null when no open period covers it.
 *
 * With a matched bank row, the bank leg is what arrived on it
 * (invoiceCashBankSek) and a sub-krona gap goes to 3740; the mark-paid doors
 * pass no row and book the customer share.
 */
export async function createInvoiceCashEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  paymentDate: string,
  entityType: EntityType = 'enskild_firma',
  customerName?: string,
  settlementAccountNumber: string = '1930',
  bankTransaction?: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  const { description, lines } = buildInvoiceCashLines(
    invoice,
    entityType,
    customerName,
    settlementAccountNumber,
    invoiceCashBankSek(bankTransaction),
  )

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description,
    source_type: 'invoice_cash_payment',
    source_id: invoice.id,
    ...(bankTransaction ? { bank_booking_context: [bankBookingContext(bankTransaction, settlementAccountNumber)] } : {}),
    lines,
  }

  return createJournalEntry(supabase, companyId, userId, input)
}

