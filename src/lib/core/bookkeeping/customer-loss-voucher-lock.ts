/**
 * The storno service refuses a rättelse of a kundförlust voucher with this
 * error. It lives in the kernel because the storno service throws it; the
 * kundförlust feature re-exports it (lib/customer-loss/errors.ts).
 * Dependency-free: a client component imports it through that re-export.
 */

/**
 * A rättelse (correction or redating) of a kundförlust voucher. The decision
 * row names its voucher's amounts and date, so the only sanctioned way back
 * is a storno of the whole voucher and a new decision.
 */
export class CustomerLossVoucherLockedError extends Error {
  readonly code = 'CUSTOMER_LOSS_VOUCHER_LOCKED' as const
  constructor() {
    super('A customer loss voucher is not corrected in place; reverse it and book the decision again')
    this.name = 'CustomerLossVoucherLockedError'
  }
}
