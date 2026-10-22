/**
 * Codes of the set-off (kvittning) services. Each is registered with its
 * Swedish and English words in lib/errors/structured-errors.ts (SETOFF), so
 * the routes, the operations and getErrorMessage() translate them the same
 * way. The database function book_counterparty_setoff answers the same codes
 * for the refusals it re-checks under its row locks.
 *
 * Dependency-free: client components import the types and the re-export.
 */
export type SetoffErrorCode =
  | 'SETOFF_DISABLED'
  | 'SETOFF_FORBIDDEN'
  | 'SETOFF_INVALID_REQUEST'
  | 'SETOFF_INVOICE_NOT_FOUND'
  | 'SETOFF_SUPPLIER_INVOICE_NOT_FOUND'
  | 'SETOFF_INVOICE_NOT_ELIGIBLE'
  | 'SETOFF_SUPPLIER_INVOICE_NOT_ELIGIBLE'
  | 'SETOFF_INVOICE_NOT_OPEN'
  | 'SETOFF_SUPPLIER_INVOICE_NOT_OPEN'
  | 'SETOFF_CURRENCY_UNSUPPORTED'
  | 'SETOFF_DEDUCTION_UNSUPPORTED'
  | 'SETOFF_INVOICE_NOT_BOOKED'
  | 'SETOFF_NO_PARTY'
  | 'SETOFF_PARTY_MISMATCH'
  | 'SETOFF_COLLECTION_OPEN'
  | 'SETOFF_PAYMENT_IN_FLIGHT'
  | 'SETOFF_INVALID_AMOUNT'
  | 'SETOFF_AMOUNT_EXCEEDS_REMAINING'
  | 'SETOFF_DATE_INVALID'
  | 'SETOFF_NO_FISCAL_PERIOD'
  | 'SETOFF_PERIOD_LOCKED'
  | 'SETOFF_LEDGER_MISMATCH'
  | 'SETOFF_RACE'
  | 'SETOFF_BOOKING_FAILED'
  | 'SETOFF_PARTY_NOT_FOUND'

/**
 * A storno of a set-off voucher whose invoices have moved on since (one was
 * credited or written off): restoring the set-off would contradict them.
 * Thrown by reverseEntry() before anything is posted.
 */
export class SetoffReversalRefusedError extends Error {
  readonly code = 'SETOFF_REVERSAL_BLOCKED' as const
  constructor() {
    super('One of the set-off invoices has been credited or written off since; the set-off cannot be reversed')
    this.name = 'SetoffReversalRefusedError'
  }
}

export { SetoffVoucherLockedError } from '@/lib/core/bookkeeping/counterparty-setoff-voucher-lock'
