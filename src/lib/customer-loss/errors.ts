/**
 * Codes of the kundförlust services. Each is registered with its Swedish and
 * English words in lib/errors/structured-errors.ts (CUSTOMER_LOSS), so the
 * route, the operation and getErrorMessage() translate them the same way.
 *
 * Dependency-free: the bookkeeping engine and the storno service import the
 * typed errors below.
 */
export type CustomerLossErrorCode =
  | 'CUSTOMER_LOSS_DISABLED'
  | 'CUSTOMER_LOSS_FORBIDDEN'
  | 'CUSTOMER_LOSS_INVOICE_NOT_FOUND'
  | 'CUSTOMER_LOSS_INVOICE_NOT_OPEN'
  | 'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED'
  | 'CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED'
  | 'CUSTOMER_LOSS_INVOICE_NOT_BOOKED'
  | 'CUSTOMER_LOSS_DOUBTFUL_NOT_BOOKED'
  | 'CUSTOMER_LOSS_LEDGER_MISMATCH'
  | 'CUSTOMER_LOSS_ALREADY_RESERVED'
  | 'CUSTOMER_LOSS_EVIDENCE_REQUIRED'
  | 'CUSTOMER_LOSS_EVIDENCE_NOT_FOUND'
  | 'CUSTOMER_LOSS_NOT_WRITTEN_OFF'
  | 'CUSTOMER_LOSS_RECOVERY_EXCEEDS'
  | 'CUSTOMER_LOSS_RECOVERY_CASE_OPEN'
  | 'CUSTOMER_LOSS_RECOVERY_NOT_BOOKED'
  | 'CUSTOMER_LOSS_NO_FISCAL_PERIOD'
  | 'CUSTOMER_LOSS_RACE'
  | 'CUSTOMER_LOSS_RECORD_FAILED'

export type CustomerLossOutcome =
  | {
      ok: true
      writeOffId: string
      journalEntryId: string | null
      invoiceStatus: string
      /** The part of the claim the decision concerns, VAT included. */
      amount: number
    }
  | { ok: false; code: CustomerLossErrorCode; details?: Record<string, unknown> }

/**
 * A storno of a kundförlust voucher that is not the invoice's latest live
 * decision (a recovery still stands on a konstaterad write-off, say). Thrown
 * by reverseEntry() before anything is posted.
 */
export class CustomerLossReversalRefusedError extends Error {
  readonly code = 'CUSTOMER_LOSS_ANNUL_NOT_LATEST' as const
  constructor() {
    super('A later customer loss decision on the invoice must be reversed first')
    this.name = 'CustomerLossReversalRefusedError'
  }
}

export { CustomerLossVoucherLockedError } from '@/lib/core/bookkeeping/customer-loss-voucher-lock'
