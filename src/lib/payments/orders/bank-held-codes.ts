/**
 * The warning codes checkBankHeldPayments answers (signed-payment.ts), apart
 * from the read so a dialog can tell them apart without bundling it: the
 * dialogs ask GET /api/supplier-invoices/bank-held-payments instead.
 */

/** A payment, signed or being signed, that the bank still makes on its date. */
export const SIGNED_BANK_PAYMENT_WARNING = 'SI_SIGNED_BANK_PAYMENT'
/** An unsigned payment the bank holds: it never executes, and the status sync asks the bank to cancel it. */
export const UNSIGNED_BANK_PAYMENT_WARNING = 'SI_UNSIGNED_BANK_PAYMENT'
/** The orders could not be read: nobody can say whether the bank holds a payment. */
export const BANK_PAYMENT_CHECK_FAILED_WARNING = 'SI_BANK_PAYMENT_CHECK_FAILED'
