/**
 * Whether an invoice's open claim can take a kundförlust decision, and where
 * the menu shows (build spec 3.10).
 */
import { roundOre } from '@/lib/money'
import type { CustomerLossErrorCode } from './errors'
import type { CustomerLossInvoice, CustomerLossState, LatestCase } from './state'

/** Invoice statuses that still carry an open claim on 1510. */
export const OPEN_CLAIM_STATUSES = ['sent', 'overdue', 'partially_paid'] as const

/** Close reasons that say the customer cannot pay (Appendix A of the build spec). */
export const LOSS_CLOSE_REASONS = ['insolvent', 'bankrupt', 'deceased', 'moved_abroad'] as const

function isRealInvoice(invoice: Pick<CustomerLossInvoice, 'document_type' | 'credited_invoice_id'>): boolean {
  return (invoice.document_type ?? 'invoice') === 'invoice' && !invoice.credited_invoice_id
}

/**
 * The menu entry "Bokför kundförlust": on any overdue SEK invoice (with or
 * without a case), and on an invoice whose collection case closed because
 * the customer cannot pay.
 */
export function customerLossMenuVisible(
  invoice: Pick<CustomerLossInvoice, 'status' | 'currency' | 'due_date' | 'remaining_amount' | 'document_type' | 'credited_invoice_id'>,
  latestCase: Pick<LatestCase, 'is_open' | 'close_reason'> | null,
  today: string,
): boolean {
  if (!isRealInvoice(invoice)) return false
  if ((invoice.currency ?? 'SEK') !== 'SEK') return false
  if (!(OPEN_CLAIM_STATUSES as readonly string[]).includes(invoice.status)) return false
  if (roundOre(invoice.remaining_amount) <= 0) return false
  const overdue = invoice.status === 'overdue' || (!!invoice.due_date && invoice.due_date < today)
  const closedAsLoss =
    !!latestCase && !latestCase.is_open && (LOSS_CLOSE_REASONS as readonly string[]).includes(latestCase.close_reason ?? '')
  return overdue || closedAsLoss
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
  if (!(OPEN_CLAIM_STATUSES as readonly string[]).includes(invoice.status)) return 'CUSTOMER_LOSS_INVOICE_NOT_OPEN'
  if (roundOre(invoice.remaining_amount) <= 0) return 'CUSTOMER_LOSS_INVOICE_NOT_OPEN'
  if (invoice.deduction_total > 0) return 'CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED'
  if (!state.booked) {
    // Faktureringsmetoden books every invoice as a fordran; one that is not
    // booked yet (deferred booking) is booked first.
    return state.accountingMethod === 'cash' ? null : 'CUSTOMER_LOSS_INVOICE_NOT_BOOKED'
  }
  if (roundOre(state.basis - invoice.paid_amount) !== roundOre(invoice.remaining_amount)) {
    return 'CUSTOMER_LOSS_LEDGER_MISMATCH'
  }
  return null
}
