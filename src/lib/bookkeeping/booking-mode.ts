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
 * The payment flows route on whether a live journal-entry link exists, but
 * only kontantmetoden books the whole invoice at payment. Under
 * faktureringsmetoden a payment is a clearing (2440 or 1510), so a supplier
 * invoice still unbooked when it is settled is booked first through the
 * Bokför step (lib/supplier-invoices/registration-first.ts). The customer
 * payment doors have no such step yet.
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
 * Whether issuing THIS customer document (send or mark sent) posts its own
 * verifikat. Only a faktura books at issue: a proforma, an offert and a
 * följesedel are marked sent without one in every accounting method. One rule
 * for the issue step and the send dialog that describes it beforehand, so the
 * dialog never promises a booking for a quote (crm#1202). Credit notes have
 * their own rule (creditNoteNeedsJournalEntry).
 */
export function issueBooksDocument(
  document: { document_type?: string | null },
  settings: Parameters<typeof booksInvoicesOnIssue>[0],
): boolean {
  const isRealInvoice = !document.document_type || document.document_type === 'invoice'
  return isRealInvoice && booksInvoicesOnIssue(settings)
}

/**
 * When an invoice's own verifikat is posted, for the surfaces that describe
 * it before the user confirms (review dialogs, ready lines). Derived from
 * booksInvoicesOnIssue so a UI never re-derives it from accounting_method:
 *
 * - 'issue': faktureringsmetoden, posted at registration (or send).
 * - 'payment': kontantmetoden, posted when the invoice is paid, as one cash
 *   entry with no 2440/1510 leg. Wins over the defer flag.
 * - 'manual': defer_invoice_booking, posted by the explicit Bokför step.
 */
export type InvoiceBookingMoment = 'issue' | 'payment' | 'manual'

export function invoiceBookingMoment(
  settings: Parameters<typeof booksInvoicesOnIssue>[0],
): InvoiceBookingMoment {
  if (booksInvoicesOnIssue(settings)) return 'issue'
  return settings?.accounting_method === 'cash' ? 'payment' : 'manual'
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

/** The booked-ness signals on a customer invoice being credited. */
export interface CustomerCreditNoteOriginal {
  /** Set once the sale reached the ledger, at issue or at payment. */
  journal_entry_id?: string | null
  status?: string | null
  paid_at?: string | null
  paid_amount?: number | null
}

/**
 * Whether a customer credit note must post a reversing verifikat.
 *
 * The test is "did the original reach the ledger", not "which accounting
 * method is configured". Under faktureringsmetoden the sale was booked at
 * issue, so the reversal always applies; a deferred original that is still
 * unbooked is booked first (creditBooksOriginalFirst), so the reversal
 * applies there too. Under kontantmetoden nothing is
 * booked at issue, and skipping the credit note is correct while the invoice
 * is still unpaid: there is no entry to reverse and recognition waits for
 * cash. Once the invoice has been PAID, the payment verifikat already booked
 * the revenue and the utgående moms (26xx, rutorna 10-12). Leaving that
 * un-reversed overstates both for as long as the credit stands, and the
 * original is marked 'credited' with no accounting trace at all, so nothing
 * links a later refund back to it. ML 17 kap: the seller reduces utgående
 * moms in the credit note's period.
 *
 * createCreditNoteJournalEntry's shape works for both cases: the 1510 credit
 * leaves the refund owed to the customer on kundfordringar, which the outgoing
 * refund payment clears, exactly as the supplier side leaves a 2440 debit.
 */
export function creditNoteNeedsJournalEntry(
  accountingMethod: string,
  original: CustomerCreditNoteOriginal | null | undefined,
): boolean {
  if ((accountingMethod || 'accrual') === 'accrual') return true
  return customerOriginalReachedLedger(original)
}

/**
 * Whether the customer invoice's sale is in the ledger: its own verifikat is
 * linked (at issue, by the explicit Bokför step, or a migrated
 * registration), or it was paid, and the payment booked the full cash-style
 * entry because no entry existed yet.
 */
function customerOriginalReachedLedger(original: CustomerCreditNoteOriginal | null | undefined): boolean {
  if (!original) return false
  return (
    !!original.journal_entry_id ||
    original.status === 'paid' ||
    !!original.paid_at ||
    Math.round(Math.abs(original.paid_amount ?? 0) * 100) !== 0
  )
}

/**
 * Whether crediting this customer invoice must first book the original's own
 * verifikat (accounted#45).
 *
 * Under faktureringsmetoden with defer_invoice_booking (#967) an invoice is
 * sent without a verifikat and booked later by the explicit Bokför step. The
 * sent invoice and its kreditfaktura are both affärshändelser that must be
 * bokförda (BFL 5 kap 1-2 §§; faktureringsmetoden books at fakturadatum),
 * and the credit verifikat is the mirror of the original's (ML 17 kap
 * 22-23 §§: utgående moms is reduced in the credit's period). Reversing a
 * sale the books never recorded would understate revenue and utgående moms,
 * and afterwards the original could not be booked at all (it is credited).
 * So the credit books the original first through the same Bokför step, then
 * posts its own reversal.
 *
 * Deferred companies only: there a missing link is what "unbooked" means,
 * the way the worklist and the Bokför step read it. A company that books at
 * issue can hold unlinked originals whose sale is in the ledger through
 * migrated or SIE-imported verifikat (fxExposureScope reads them the same
 * way), and booking those again would double the revenue. Kontantmetoden
 * books the sale at payment, never here.
 */
export function creditBooksOriginalFirst(
  settings: Parameters<typeof booksInvoicesOnIssue>[0],
  original: CustomerCreditNoteOriginal | null | undefined,
): boolean {
  if (!original) return false
  if (invoiceBookingMoment(settings) !== 'manual') return false
  return !customerOriginalReachedLedger(original)
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
