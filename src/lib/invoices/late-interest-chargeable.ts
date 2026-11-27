/**
 * Which late-paid invoice a räntefaktura may charge. Pure: the Dröjsmålsränta
 * page offers exactly the rows the create service then accepts
 * (late-interest-invoices.ts), read from the report
 * (late-payment-interest-report.ts).
 */

/** The räntefaktura that charges an invoice's dröjsmålsränta. */
export interface LateInterestInvoiceRef {
  id: string
  /** The number to show: the draft label while it is an unnumbered draft. */
  invoice_number: string
  status: string
}

/**
 * Paid in full (an open remainder still earns interest, so the amount is not
 * final), not charged by a räntefaktura already, and some interest to charge.
 */
export function isLateInterestChargeable(row: {
  fully_paid: boolean
  interest_invoice: LateInterestInvoiceRef | null
  interest: number
}): boolean {
  return row.fully_paid && row.interest_invoice === null && row.interest > 0
}
