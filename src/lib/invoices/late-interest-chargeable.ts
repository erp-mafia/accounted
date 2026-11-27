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
 * final), not charged by a räntefaktura already, some interest to charge, and
 * a customer to send the räntefaktura to.
 */
export function isLateInterestChargeable(row: {
  fully_paid: boolean
  interest_invoice: LateInterestInvoiceRef | null
  interest: number
  customer_id: string | null
}): boolean {
  return row.fully_paid && row.interest_invoice === null && row.interest > 0 && row.customer_id !== null
}
