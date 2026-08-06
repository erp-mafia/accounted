/**
 * #967 "Registrera men bokför inte": whether issuing an invoice (registering
 * a supplier invoice, sending a customer invoice) books it inline.
 *
 * Inline booking happens only under faktureringsmetoden (accrual) with
 * defer_invoice_booking off. Kontantmetoden companies never book at issue
 * (they book at payment), and deferred companies book via the explicit
 * "Bokför" routes (POST /api/supplier-invoices/[id]/book,
 * POST /api/invoices/[id]/book) instead.
 *
 * The payment flows need no gate of their own: both mark-paid paths already
 * route on whether a live journal-entry link exists, so an invoice that is
 * still unbooked when paid gets the full cash-style entry at payment.
 */
export function booksInvoicesOnIssue(
  settings:
    | { accounting_method?: string | null; defer_invoice_booking?: boolean | null }
    | null
    | undefined
): boolean {
  // No settings row: match the historical default (accrual, book at issue).
  if (!settings) return true
  return (settings.accounting_method || 'accrual') === 'accrual' && !settings.defer_invoice_booking
}

/**
 * Kontantmetoden guard for the GENERATED payment entries on never-booked
 * invoices. createInvoiceCashEntry and createSupplierInvoiceCashEntry always
 * book the FULL invoice (revenue or expense + VAT + a full-total settlement
 * leg); neither takes a payment amount. A generated cash entry is therefore
 * only valid when the payment settles the invoice in full from a fully
 * unpaid state:
 *
 * - a partial payment would book the whole invoice against a smaller bank
 *   movement and declare the whole VAT at once, but bokslutsmetoden reports
 *   moms at payment, so each installment's moms belongs to its own receipt
 *   period;
 * - completing a previously part-paid invoice would book the full total a
 *   second time on the settlement account.
 *
 * Callers reject with INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED (customer) or
 * SI_CASH_PARTIAL_UNSUPPORTED (supplier) until per-installment recognition
 * exists. Invoices already booked at issue are never affected: their payment
 * is a plain clearing entry against 1510/2440, which handles partials fine.
 */
export function cashPartialBlockReason(opts: {
  invoiceAlreadyBooked: boolean
  accountingMethod: string
  priorPaidAmount: number | null | undefined
  paysRemainingInFull: boolean
}): 'partial_payment' | 'previously_partially_paid' | null {
  if (opts.invoiceAlreadyBooked) return null
  if ((opts.accountingMethod || 'accrual') !== 'cash') return null
  if (!opts.paysRemainingInFull) return 'partial_payment'
  if (Math.round((opts.priorPaidAmount ?? 0) * 100) !== 0) return 'previously_partially_paid'
  return null
}

/** The booked-ness signals on a supplier invoice being credited. */
export interface SupplierCreditNoteOriginal {
  /** Set when the invoice was booked at registration (faktureringsmetoden). */
  registration_journal_entry_id?: string | null
  /** Set when the invoice was booked at payment (kontantmetoden). */
  payment_journal_entry_id?: string | null
  status?: string | null
  paid_at?: string | null
  paid_amount?: number | null
}

/**
 * Whether a supplier credit note must post a reversing verifikat.
 *
 * The mirror of creditNoteNeedsJournalEntry() on the customer side: a credit
 * note reverses whatever actually reached the ledger, so the test is "did the
 * original get booked", not "which accounting method is configured".
 *
 * Under faktureringsmetoden the original was booked at registration, so the
 * reversal always applies. Under kontantmetoden nothing is booked at
 * registration, and skipping the credit note is correct while the invoice is
 * still unpaid: there is no entry to reverse and recognition waits for cash.
 * But once the invoice has been PAID, the payment verifikat has already booked
 * the expense and claimed the ingående moms (2641, ruta 48). Leaving that
 * un-reversed overstates both the cost and the VAT deduction for as long as
 * the credit stands, and the invoice is marked 'credited' with no accounting
 * trace at all, so nothing links a later refund back to it.
 *
 * createSupplierCreditNoteEntry's shape works for both cases: the 2440 debit
 * leaves a claim on the supplier that the refund payment clears, exactly as
 * the customer side leaves a 1510 credit for a refund owed to the customer.
 */
export function supplierCreditNoteNeedsJournalEntry(
  accountingMethod: string,
  original: SupplierCreditNoteOriginal | null | undefined,
): boolean {
  if ((accountingMethod || 'accrual') === 'accrual') return true
  if (!original) return false
  return (
    !!original.registration_journal_entry_id ||
    !!original.payment_journal_entry_id ||
    original.status === 'paid' ||
    !!original.paid_at ||
    Math.round(Math.abs(original.paid_amount ?? 0) * 100) !== 0
  )
}
