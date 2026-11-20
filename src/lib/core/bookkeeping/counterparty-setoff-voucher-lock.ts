/**
 * The storno service refuses a rättelse of a kvittning voucher with this
 * error. It lives in the kernel because the storno service throws it; the
 * set-off feature re-exports it (lib/invoices/counterparty-setoff/errors.ts).
 * Dependency-free: a client component imports it through that re-export.
 */

/**
 * A rättelse (correction or redating) of a set-off voucher. The set-off row,
 * both invoices and their payment rows name the voucher's amount and date, so
 * the only sanctioned way back is a storno of the whole voucher, which
 * restores both invoices.
 */
export class SetoffVoucherLockedError extends Error {
  readonly code = 'SETOFF_VOUCHER_LOCKED' as const
  constructor() {
    super('A set-off voucher is not corrected in place; reverse it and book the set-off again')
    this.name = 'SetoffVoucherLockedError'
  }
}
