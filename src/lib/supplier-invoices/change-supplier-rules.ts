/**
 * Byt leverantör: what an invoice's own row says about whether its supplier
 * can still be changed. Client-safe (no I/O), so the detail page offers the
 * action on exactly the rows the server takes; the server
 * (change-supplier.ts) adds what only reads can tell: a payment row, an
 * approval in the attest round, a payment file or bank payment, the new
 * supplier and the verifikat.
 */
import { isUnsettledSupplierInvoiceStatus } from './lifecycle'
import { isSupplierInvoiceAttested } from './reported-status'

/** Why the row refuses a change of supplier. */
export type SupplierChangeRowRefusal = 'credit_note' | 'self_billed' | 'not_unpaid' | 'attested' | 'payment_under_way'

/** The refusal's code in the registry (lib/errors/structured-errors.ts). */
export const SUPPLIER_CHANGE_REFUSAL_CODES: Record<SupplierChangeRowRefusal, string> = {
  credit_note: 'SI_CHANGE_SUPPLIER_CREDIT_NOTE',
  self_billed: 'SI_SELF_BILL_IMMUTABLE',
  not_unpaid: 'SI_CHANGE_SUPPLIER_NOT_UNPAID',
  attested: 'SI_CHANGE_SUPPLIER_ATTESTED',
  payment_under_way: 'SI_CHANGE_SUPPLIER_PAYMENT_UNDER_WAY',
}

/**
 * The row's answer, null when it allows the change:
 *   - a credit note follows the invoice it credits, and a självfaktura is our
 *     own document issued in the supplier's name, its parties frozen;
 *   - only an invoice still unsettled and with nothing paid;
 *   - only one nobody has attested: the attest is a person's word that this
 *     supplier is owed the amount, and it would vouch for a payee it never
 *     saw (isSupplierInvoiceAttested: there is no un-attest);
 *   - nothing marked as typed into the bank ("Inlagd i banken"): that
 *     payment goes to the old supplier's account.
 */
export function supplierChangeRowRefusal(invoice: {
  status: string
  is_credit_note?: boolean | null
  is_self_billed?: boolean | null
  approved_at?: string | null
  paid_amount?: number | string | null
  bank_entered_at?: string | null
}): SupplierChangeRowRefusal | null {
  if (invoice.is_credit_note) return 'credit_note'
  if (invoice.is_self_billed) return 'self_billed'
  if (!isUnsettledSupplierInvoiceStatus(invoice.status) || Number(invoice.paid_amount ?? 0) > 0) return 'not_unpaid'
  if (isSupplierInvoiceAttested(invoice)) return 'attested'
  if (invoice.bank_entered_at) return 'payment_under_way'
  return null
}
