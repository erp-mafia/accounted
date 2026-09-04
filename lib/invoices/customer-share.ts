/**
 * The customer's share of an invoice: ONE definition.
 *
 * Under ROT/RUT fakturamodellen the company invoices the full amount and the
 * customer pays the total minus the skattereduktion; the deduction is a
 * fordran on Skatteverket carried on 1513, never on the customer
 * (swedish-invoice-compliance, invoice-rules.md section 8). Every settlement
 * path records the customer share as the payment row amount, so "what is
 * still outstanding" must be measured against that share.
 *
 * This arithmetic used to be re-derived by hand at every reader and one copy
 * drifted (#2248: the kontantmetod cut-off compared payments against the
 * gross total). It now lives here and in exactly one SQL twin:
 *
 *   invoices_remaining_amount_guard (migration 20260817191708)
 *   remaining_amount = GREATEST(0, ROUND(total - paid_amount - deduction_total, 2))
 *
 * Change both or neither. The guard floors at zero because it persists the
 * column; the functions here return the signed value and each writer applies
 * the floor it needs (payment-sync mirrors GREATEST(0, ...), the kontantmetod
 * cut-off floors on the invoice's own side so credit notes keep their sign).
 */
import { roundOre } from '@/lib/money'

/** The invoice header fields the customer-share arithmetic reads. */
export interface CustomerShareInvoice {
  /** Invoice total including moms, in invoice currency. Negative on a credit note. */
  total: number
  /**
   * ROT/RUT skattereduktion in invoice currency. Stored as a positive
   * magnitude under CHECK (deduction_total >= 0), also on a credit note.
   * Null, undefined and 0 all mean "no deduction".
   */
  deduction_total?: number | null
}

/**
 * What the customer owes on the invoice: total minus the ROT/RUT deduction.
 *
 * The deduction follows the sign of the total, so a credited ROT invoice
 * (total -25 000, deduction_total 7 500) owes the customer -17 500 back and
 * nets to zero against its original. An invoice without a deduction returns
 * its total exactly as stored.
 */
export function invoiceCustomerShare(invoice: CustomerShareInvoice): number {
  const deduction = Math.abs(invoice.deduction_total ?? 0)
  // `!(x > 0)` also catches NaN: a non-numeric deduction reads as none rather
  // than poisoning every downstream amount.
  if (!(deduction > 0)) return invoice.total
  return roundOre(invoice.total - Math.sign(invoice.total) * deduction)
}

/**
 * The customer's share still unpaid after `paid`, signed and unfloored:
 * positive is a fordran on the customer, negative means over-collected (or,
 * on a credit note, still owed back). `paid` is the sum of the payment rows
 * the caller considers settled (all of them, or only those on or before a
 * cut-off date), in invoice currency.
 */
export function invoiceCustomerOutstanding(invoice: CustomerShareInvoice, paid: number): number {
  return roundOre(invoiceCustomerShare(invoice) - paid)
}
