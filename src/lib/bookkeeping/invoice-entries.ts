import { bankBookingContext } from '@/lib/bookkeeping/bank-booking-context'
import { findFiscalPeriod } from './engine'
import { coerceDimensionsBag } from './dimension-resolver'
import { clearedSek, statedSettlement } from './ledger-carried-sek'
import { fxDifferenceLine } from './ore-rounding'
import { createLogger } from '@/lib/logger'
import { equalOre, roundOre, sumOre } from '@/lib/money'
import { postingPort } from '@/lib/posting/port'
import { assertAccruedIncomeLinesBookable } from './accruals/accrued-cost-guard'
import {
  creditNoteBusinessEvent,
  invoicePaymentBusinessEvent,
  invoiceRegistrationBusinessEvent,
  type InvoicePaymentPostingContext,
  type InvoicePostingContext,
} from './invoice-business-events'
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
  creditNoteDeductionSplit,
  headerToSekOrThrow,
  installmentOutputVat,
  invoiceCashBankSek,
  splitDeductionShare,
} from './invoice-lines'
export { buildInvoiceCashLines, buildInvoiceCashPartialLines } from './invoice-lines'

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
 *
 * Posting port (step 2f): the verifikat goes through lib/posting, which
 * hands `input` to the engine unchanged and, while POSTING_EVENTS is shadow
 * or strict, records the sale.invoiced event first and has the engine link
 * it to the draft before a voucher number is drawn. `options.posting` is what
 * the door saw (its link basis), called only while the port is on: off, the
 * engine gets the call it always did.
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
  options?: InvoiceJournalEntryOptions & { posting?: () => InvoicePostingContext }
): Promise<JournalEntry | null> {
  const input = await buildInvoiceJournalEntryInput(supabase, companyId, invoice, entityType, customerName, options)
  if (!input) return null
  const userEditedLines = !!options?.customLines && options.customLines.length > 0
  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => invoiceRegistrationBusinessEvent(invoice, options?.posting?.(), { userEditedLines }),
    input,
  })
}

export interface InvoiceJournalEntryOptions {
  descriptionPrefix?: string
  numberOverride?: string | null
  customLines?: CreateJournalEntryLineInput[]
}

/**
 * The verifikat createInvoiceJournalEntry would post, without posting it: the
 * fiscal period lookup (and, for an upplupen intäkt on 17xx, the lock state
 * of its month-ends) are the only database reads, and nothing is written.
 * The deferred "Bokför" dry run previews these lines. Returns null when no
 * open fiscal period covers invoice_date. Throws the same generator errors
 * (InvoiceFxRateMissingError, AccruedIncomePeriodInvalidError,
 * AccruedIncomePeriodLockedError) the committing path throws.
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

  // An upplupen intäkt (17xx line, #62) books its months right after this
  // entry: refuse here, before the 17xx credit exists, when one of those
  // months cannot take its entry (every door that books a sale reaches this
  // point). User-edited lines above book as reviewed and get no schedule.
  await assertAccruedIncomeLinesBookable(supabase, companyId, invoice.invoice_date, invoice.items ?? [])

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
 * The lines of the payment verifikat createInvoicePaymentJournalEntry posts,
 * as a pure function so a preview shows exactly what the mark-paid doors
 * book: the settlement account debited and 1510 credited for what is still
 * outstanding (remaining_amount, net of the ROT/RUT share), or the partial
 * `paymentAmount`. A foreign invoice clears what 1510 carries when the caller
 * read it (`carried_sek`, carriedSekOf), so nothing is stranded on a paid
 * invoice. An exchange-rate difference is measured from the rate: the bank takes
 * that figure plus the difference and the gap to what 1510 gives up is the
 * 3960/7960 line (statedSettlement).
 * Throws InvoiceFxRateMissingError for a foreign amount without a rate, like
 * the booking itself.
 */
export function buildInvoicePaymentLines(
  invoice: Invoice & { carried_sek?: number | null },
  customerName: string | undefined,
  settlementAccountNumber: string,
  exchangeRateDifference?: number,
  paymentAmount?: number,
): { description: string; lines: CreateJournalEntryLineInput[] } {
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
  const sekAtRate = isPartial
    ? headerToSekOrThrow(paymentAmount, null, invoice.currency, invoice.exchange_rate)
    : settlesFullTotal
      ? headerToSekOrThrow(invoice.total, invoice.total_sek, invoice.currency, invoice.exchange_rate)
      : headerToSekOrThrow(outstanding, null, invoice.currency, invoice.exchange_rate)
  const bookedSekAmount =
    invoice.carried_sek != null
      ? clearedSek({
          amount: paymentAmount ?? outstanding,
          remaining: outstanding,
          carried: invoice.carried_sek,
          rate: invoice.exchange_rate ?? 0,
        })
      : sekAtRate
  const { bankSek, gainSek } = statedSettlement({
    cleared: bookedSekAmount,
    sekAtRate,
    difference: isPartial ? undefined : exchangeRateDifference,
  })

  // Debit the settlement account (bank by default) at the SEK received, credit
  // kundfordringar at the SEK booked. Received more than booked is a gain
  // (Cr 3960), less a loss (Dr 7960).
  const lines: CreateJournalEntryLineInput[] = [
    { account_number: settlementAccountNumber, debit_amount: bankSek, credit_amount: 0, line_description: desc },
    { account_number: '1510', debit_amount: 0, credit_amount: roundOre(bookedSekAmount), line_description: desc },
  ]
  if (gainSek !== 0) lines.push(fxDifferenceLine(gainSek))

  if (defaultDimensions) {
    // Copy per line: a shared bag object would let one line's mutation
    // leak into every other line (same contract as proposal stamping).
    for (const line of lines) line.dimensions = { ...defaultDimensions }
  }

  return { description: desc, lines }
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
 *
 * Posting port (step 2f-2): the verifikat goes through lib/posting, which
 * hands `input` to the engine unchanged and, while POSTING_EVENTS is shadow
 * or strict, records the sale.payment_received event first and has the
 * engine link it to the draft before a voucher number is drawn. `posting` is
 * what the door saw (its link basis and the debt the payment settles),
 * called only while the port is on: off, the engine gets the call it always
 * did.
 */
export async function createInvoicePaymentJournalEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice & { carried_sek?: number | null },
  paymentDate: string,
  exchangeRateDifference: number | undefined,
  customerName: string | undefined,
  paymentAmount: number | undefined,
  settlementAccountNumber: string,
  bankTransaction?: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>,
  posting?: () => InvoicePaymentPostingContext,
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  const { description: desc, lines } = buildInvoicePaymentLines(
    invoice, customerName, settlementAccountNumber, exchangeRateDifference, paymentAmount,
  )

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description: desc,
    source_type: 'invoice_paid',
    source_id: invoice.id,
    ...(bankTransaction ? { bank_booking_context: [bankBookingContext(bankTransaction, settlementAccountNumber)] } : {}),
    lines,
  }

  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () =>
      invoicePaymentBusinessEvent(
        invoice,
        input,
        { paymentAccount: settlementAccountNumber, generated: true, bankLine: !!bankTransaction },
        posting?.(),
      ),
    input,
  })
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
  originalVoucherRef?: string,
  /** What the door saw, read by the posting port only while POSTING_EVENTS is on. */
  posting?: () => InvoicePostingContext,
  /** See buildCreditNoteLines' options.deductionBookedSek. */
  options: { deductionBookedSek?: number | null } = {},
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, creditNote.invoice_date)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for credit note date:', creditNote.invoice_date)
    return null
  }

  const lines = buildCreditNoteLines(creditNote, entityType, originalVoucherRef, options)
  // A credit of part of the share (the customer's, and what a payout booked)
  // takes back only that moms.
  const partOfShare = creditNoteDeductionSplit(creditNote, options.deductionBookedSek) !== null

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

  // Posting port (step 2f), as the registration: the sale.credited event is
  // recorded and linked to the draft only while POSTING_EVENTS is on.
  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => {
      const vat = Math.abs(installmentOutputVat(input.lines))
      return creditNoteBusinessEvent(
        partOfShare ? { ...creditNote, vat_amount: vat, vat_amount_sek: vat } : creditNote,
        posting?.(),
      )
    },
    input,
  })
}

/**
 * Create the journal entry for kontantmetoden (cash method) when payment is
 * received: the lines of buildInvoiceCashLines, booked in the open period of
 * the payment date. Returns null when no open period covers it.
 *
 * With a matched bank row, the bank leg is what arrived on it
 * (invoiceCashBankSek) and a sub-krona gap goes to 3740; the mark-paid doors
 * pass no row and book the customer share. `overpaymentAccount` books an
 * excess of a krona or more on that row, `options.feeAccount` a payment
 * provider's fee that left the row short of it (buildInvoiceCashLines).
 *
 * `options.deferDeductionShare`: kontantmetoden's two steps for a ROT/RUT
 * or grön teknik invoice (buildInvoiceCashLines); only a kontantmetod
 * company passes true.
 *
 * Posting port (step 2f-2), as createInvoicePaymentJournalEntry: the
 * sale.payment_received event, with the moms the sale books at payment, is
 * recorded and linked to the draft only while POSTING_EVENTS is on.
 */
export async function createInvoiceCashEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoice: Invoice,
  paymentDate: string,
  entityType: EntityType,
  customerName: string | undefined,
  settlementAccountNumber: string,
  bankTransaction?: Pick<Transaction, 'id' | 'cash_account_id' | 'date' | 'amount' | 'currency'>,
  overpaymentAccount?: string,
  posting?: () => InvoicePaymentPostingContext,
  options: { deferDeductionShare?: boolean; feeAccount?: string } = {},
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
    overpaymentAccount,
    options,
  )
  // Bokslutsmetoden's first step books only the moms of the customer's
  // share: the event states that, as an installment states its own.
  const twoSteps = !!options.deferDeductionShare && splitDeductionShare(invoice.items, invoice.currency) !== null

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description,
    source_type: 'invoice_cash_payment',
    source_id: invoice.id,
    ...(bankTransaction ? { bank_booking_context: [bankBookingContext(bankTransaction, settlementAccountNumber)] } : {}),
    lines,
  }

  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => {
      const vat = installmentOutputVat(input.lines)
      return invoicePaymentBusinessEvent(
        twoSteps ? { ...invoice, vat_amount: vat, vat_amount_sek: vat } : invoice,
        input,
        { paymentAccount: settlementAccountNumber, generated: true, bankLine: !!bankTransaction },
        posting?.(),
      )
    },
    input,
  })
}


/** What the door saw when it booked an installment, read by the posting port only while POSTING_EVENTS is on. */
export interface InvoiceCashInstallmentPosting {
  invoice: Pick<Invoice, 'id' | 'customer_id' | 'currency' | 'exchange_rate' | 'vat_treatment'>
  context?: InvoicePaymentPostingContext
}

/**
 * Book one pro-rata kontantmetoden installment: the lines
 * buildInvoiceCashPartialLines produced, booked as they are in the open
 * period of the payment date. The caller builds them first (and checks the
 * earlier installments with checkPriorCashRecognition), so what was checked
 * is what gets booked. Returns null when no open period covers the date.
 *
 * Posting port, as createInvoiceCashEntry: the engine gets the input
 * unchanged; while POSTING_EVENTS is on, the sale.payment_received event is
 * recorded and linked to the draft first. An installment states its own
 * share of the moms (installmentOutputVat), not the invoice's, and the
 * kronor that arrived on its one debit line, the payment leg.
 */
export async function createInvoiceCashPartialEntry(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  invoiceId: string,
  installment: { description: string; lines: CreateJournalEntryLineInput[] },
  paymentDate: string,
  posting: () => InvoiceCashInstallmentPosting,
): Promise<JournalEntry | null> {
  const fiscalPeriodId = await findFiscalPeriod(supabase, companyId, paymentDate)
  if (!fiscalPeriodId) {
    log.warn('No open fiscal period found for payment date:', paymentDate)
    return null
  }

  const input: CreateJournalEntryInput = {
    fiscal_period_id: fiscalPeriodId,
    entry_date: paymentDate,
    description: installment.description,
    source_type: 'invoice_cash_payment',
    source_id: invoiceId,
    lines: installment.lines,
  }
  return postingPort.postJournalEntry({
    supabase,
    companyId,
    userId,
    event: () => {
      const seen = posting()
      const vat = installmentOutputVat(input.lines)
      const paymentAccount = input.lines.find((line) => (line.debit_amount ?? 0) > 0)?.account_number ?? null
      return invoicePaymentBusinessEvent(
        { ...seen.invoice, vat_amount: vat, vat_amount_sek: vat },
        input,
        { paymentAccount, generated: true, bankLine: false },
        seen.context,
      )
    },
    input,
  })
}

export type PriorCashRecognitionRefusal =
  /** A read failed: unknown is never "matches". */
  | 'prior_payments_unreadable'
  /** The payment rows do not add up to paid_amount, or one has no posted voucher. */
  | 'prior_payments_untraceable'
  /** The vouchers recognised other revenue or moms than the pro-rata rule. */
  | 'prior_payments_not_pro_rata'

export type PriorCashRecognitionResult =
  | { ok: true }
  | { ok: false; reason: PriorCashRecognitionRefusal; details?: Record<string, unknown> }

/**
 * Whether the ledger holds exactly what the earlier installments of a
 * never-booked kontantmetoden invoice should have recognised, before the next
 * installment books on top of them.
 *
 * The pro-rata builder computes an installment from paid_amount alone, which
 * is only right when every earlier payment was booked by the same rule. Some
 * were not: an import that set paid_amount without vouchers, a voucher linked
 * by hand, a batch voucher shared with other invoices, or a payment from
 * before the whole-payment guard existed that booked the whole invoice on its
 * first installment. Booking the next installment on top of those would count
 * revenue and moms twice, or never. So: the invoice's payment rows must add
 * up to paid_amount, each must point at a posted voucher, and those vouchers
 * must carry, per revenue and moms account, exactly `recognisedBefore` (net
 * credit). Struck lines of an inline rättelse are gone from the line table,
 * so the sum is the voucher as it stands.
 */
export async function checkPriorCashRecognition(
  supabase: SupabaseClient,
  companyId: string,
  invoiceId: string,
  priorPaid: number,
  recognisedBefore: Record<string, number>,
): Promise<PriorCashRecognitionResult> {
  const { data: rows, error: rowsError } = await supabase
    .from('invoice_payments')
    .select('amount, journal_entry_id')
    .eq('company_id', companyId)
    .eq('invoice_id', invoiceId)
  if (rowsError) return { ok: false, reason: 'prior_payments_unreadable' }

  const paymentRows = (rows ?? []) as Array<{ amount: number | string | null; journal_entry_id: string | null }>
  const rowTotal = sumOre(paymentRows.map((row) => Number(row.amount ?? 0)))
  if (!equalOre(rowTotal, priorPaid) || paymentRows.some((row) => !row.journal_entry_id)) {
    return {
      ok: false,
      reason: 'prior_payments_untraceable',
      details: { payment_rows_total: rowTotal, paid_amount: roundOre(priorPaid) },
    }
  }

  const entryIds = Array.from(new Set(paymentRows.map((row) => row.journal_entry_id as string)))
  const { data: entries, error: entriesError } = await supabase
    .from('journal_entries')
    .select('id, status')
    .eq('company_id', companyId)
    .in('id', entryIds)
  if (entriesError) return { ok: false, reason: 'prior_payments_unreadable' }
  const postedIds = new Set(
    ((entries ?? []) as Array<{ id: string; status: string }>)
      .filter((entry) => entry.status === 'posted')
      .map((entry) => entry.id),
  )
  if (entryIds.some((id) => !postedIds.has(id))) {
    return { ok: false, reason: 'prior_payments_untraceable' }
  }

  const { data: lines, error: linesError } = await supabase
    .from('journal_entry_lines')
    .select('journal_entry_id, account_number, debit_amount, credit_amount')
    .in('journal_entry_id', entryIds)
  if (linesError) return { ok: false, reason: 'prior_payments_unreadable' }

  const booked: Record<string, number> = {}
  for (const line of (lines ?? []) as Array<{
    account_number: string
    debit_amount: number | string | null
    credit_amount: number | string | null
  }>) {
    if (!(line.account_number in recognisedBefore)) continue
    booked[line.account_number] = roundOre(
      (booked[line.account_number] ?? 0) + Number(line.credit_amount ?? 0) - Number(line.debit_amount ?? 0),
    )
  }

  const mismatches = Object.entries(recognisedBefore)
    .filter(([account, expected]) => !equalOre(booked[account] ?? 0, expected))
    .map(([account, expected]) => ({ account, expected, booked: booked[account] ?? 0 }))
  if (mismatches.length > 0) {
    return { ok: false, reason: 'prior_payments_not_pro_rata', details: { accounts: mismatches } }
  }
  return { ok: true }
}
