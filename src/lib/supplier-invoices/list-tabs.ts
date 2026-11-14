/**
 * The supplier invoice list's status tabs that other surfaces link into, as
 * rules over a list row, so a link and the count behind it can be held to
 * the same definition: the byrå client list's Väntar på kund opens
 * Registrerade, its Redo att betala and the Att göra row "Betala N
 * leverantörsfakturor" open Att betala.
 */

import { canApproveSupplierInvoice } from './lifecycle'
import { isAttestedAwaitingPayment } from './reported-status'
import { openPaymentMarker, type OpenPaymentInstruction, type OpenPaymentMarker } from './stages'
import { waitsToBePaid } from './to-pay'

export interface ListTabInvoice {
  status: string
  approved_at?: string | null
  auto_debit?: boolean | null
  is_credit_note?: boolean | null
  open_payment?: OpenPaymentInstruction | null
  /** The "Inlagd i banken" tick and what decides whether it still holds (bankEnteredHolds). */
  bank_entered_at?: string | null
  due_date?: string | null
  remaining_amount?: number | null
  /**
   * The attest policy requires attest for it and it has not been given
   * (paymentWaitsForAttest), as GET /api/supplier-invoices reads it; absent
   * reads as not held.
   */
  waits_for_attest?: boolean | null
}

/** The markers that say the payment is with the bank: such an invoice waits for nobody. */
const AT_THE_BANK: ReadonlySet<OpenPaymentMarker> = new Set(['bank_payment', 'bank_entered'])

/**
 * Registrerade: what can still be attested (canApproveSupplierInvoice: not
 * attested, registered or overdue). An unattested invoice past its due date
 * is stored as 'overdue' and still waits for its attest, so it belongs here.
 */
export function isAwaitingAttestInList(invoice: ListTabInvoice): boolean {
  return canApproveSupplierInvoice(invoice)
}

/**
 * Attesterade: attested and nothing paid yet (isAttestedAwaitingPayment). An
 * attested invoice past its due date is stored as 'overdue' and is still
 * attested, so it stays here; the tab used to read the stored status and lost
 * it the day after the due date (for #207).
 */
export function isAttestedInList(invoice: ListTabInvoice): boolean {
  return isAttestedAwaitingPayment(invoice)
}

/**
 * Att betala is what waits for someone to pay it (lib/supplier-invoices/to-pay.ts
 * waitsToBePaid), the same invoices the Att göra Betala row counts. At the bank
 * is an open bank payment (crm#1243) or the "Inlagd i banken" tick until the
 * invoice falls due (crm#1824, bankEnteredHolds); an invoice in a payment file
 * stays, a generated file may never have reached the bank.
 */
export function isToPayInList(invoice: ListTabInvoice): boolean {
  const marker = openPaymentMarker(invoice)
  return waitsToBePaid(invoice, {
    atTheBank: marker !== null && AT_THE_BANK.has(marker),
    waitsForAttest: invoice.waits_for_attest === true,
  })
}
