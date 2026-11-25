/**
 * Whether an invoice's open claim can take a kundförlust decision, and where
 * the menu shows (build spec 3.10).
 */
import { isCreditNoteDocument } from '@/lib/bookkeeping/credit-note-state'
import { isInvoiceOverdue } from '@/lib/invoices/overdue'
import { roundOre } from '@/lib/money'
import { isOwedInvoiceStatus } from '@/lib/bookkeeping/matchable-statuses'
import { openReceivable } from './amounts'
import type { CustomerLossErrorCode } from './errors'
import type { CustomerLossInvoice, CustomerLossState, LatestCase } from './state'

/** Close reasons that say the customer cannot pay (Appendix A of the build spec). */
export const LOSS_CLOSE_REASONS = ['insolvent', 'bankrupt', 'deceased', 'moved_abroad'] as const

function isRealInvoice(
  invoice: Pick<CustomerLossInvoice, 'document_type' | 'credited_invoice_id'> & Partial<Pick<CustomerLossInvoice, 'total'>>,
): boolean {
  return (invoice.document_type ?? 'invoice') === 'invoice' && !isCreditNoteDocument(invoice)
}

/**
 * The menu entry "Bokför kundförlust": on any overdue SEK invoice (with or
 * without a case), and on an invoice whose collection case closed because
 * the customer cannot pay.
 */
export function customerLossMenuVisible(
  invoice: Pick<CustomerLossInvoice, 'status' | 'currency' | 'due_date' | 'remaining_amount' | 'document_type' | 'credited_invoice_id'> &
    Partial<Pick<CustomerLossInvoice, 'total'>>,
  latestCase: Pick<LatestCase, 'is_open' | 'close_reason'> | null,
  today: string,
): boolean {
  if (!isRealInvoice(invoice)) return false
  if ((invoice.currency ?? 'SEK') !== 'SEK') return false
  if (!isOwedInvoiceStatus(invoice.status)) return false
  if (roundOre(invoice.remaining_amount) <= 0) return false
  const closedAsLoss =
    !!latestCase && !latestCase.is_open && (LOSS_CLOSE_REASONS as readonly string[]).includes(latestCase.close_reason ?? '')
  return isInvoiceOverdue(invoice, today) || closedAsLoss
}

/**
 * Refusals shared by befarad and konstaterad: the claim must be a sent SEK
 * invoice with something left to pay, without a ROT/RUT share (v1), and,
 * when it reached the ledger, its remaining amount must match its voucher.
 */
export function openClaimRefusal(state: CustomerLossState): CustomerLossErrorCode | null {
  const { invoice } = state
  if (!isRealInvoice(invoice)) return 'CUSTOMER_LOSS_INVOICE_NOT_OPEN'
  if ((invoice.currency ?? 'SEK') !== 'SEK') return 'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED'
  if (!isOwedInvoiceStatus(invoice.status)) return 'CUSTOMER_LOSS_INVOICE_NOT_OPEN'
  if (roundOre(invoice.remaining_amount) <= 0) return 'CUSTOMER_LOSS_INVOICE_NOT_OPEN'
  if (invoice.deduction_total > 0) return 'CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED'
  if (!state.booked) {
    // Faktureringsmetoden books every invoice as a fordran; one that is not
    // booked yet (deferred booking) is booked first.
    return state.accountingMethod === 'cash' ? null : 'CUSTOMER_LOSS_INVOICE_NOT_BOOKED'
  }
  // The öre an issue verifikat booked on 1510 (öresavrundning) is no mismatch.
  if (openReceivable(state.basis, invoice.paid_amount, invoice.remaining_amount) === null) {
    return 'CUSTOMER_LOSS_LEDGER_MISMATCH'
  }
  return null
}

/**
 * The open claim as 151x carries it, for an invoice that reached the ledger:
 * the remaining amount, and the öresavrundning when its issue verifikat
 * booked one (openReceivable). Where the two disagree, the remaining amount:
 * openClaimRefusal stops a booking before it gets here.
 */
export function openClaimOnLedger(state: CustomerLossState): number {
  const { invoice } = state
  return openReceivable(state.basis, invoice.paid_amount, invoice.remaining_amount) ?? invoice.remaining_amount
}
