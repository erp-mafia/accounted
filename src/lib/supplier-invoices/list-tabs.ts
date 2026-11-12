/**
 * The supplier invoice list's status tabs that other surfaces link into, as
 * rules over a list row, so a link and the count behind it can be held to
 * the same definition: the byrå client list's Väntar på kund opens
 * Registrerade, its Redo att betala and the Att göra row "Betala N
 * attesterade fakturor" open Att betala.
 */

import { PAYABLE_SUPPLIER_INVOICE_STATUSES } from '@/lib/payments/batch-eligibility'
import { canApproveSupplierInvoice } from './lifecycle'
import { openPaymentMarker, type OpenPaymentInstruction, type OpenPaymentMarker } from './stages'

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
}

const PAYABLE: ReadonlySet<string> = new Set(PAYABLE_SUPPLIER_INVOICE_STATUSES)

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
 * Att betala is what still waits for someone to pay it: what the payment file
 * pays (PAYABLE_SUPPLIER_INVOICE_STATUSES, a part-paid invoice included). One
 * the supplier debits itself has nothing to pay (crm#1463). An invoice with an
 * open bank payment is not waiting either: the bank has it (or a person is
 * approving and signing it under Betalningar), every payment channel refuses
 * it, and offering it again invites paying it twice (crm#1243). One a person
 * ticked "Inlagd i banken" is not waiting either, until it falls due: then it
 * is back here, so a tick no payment followed cannot hide an unpaid invoice
 * (crm#1824, bankEnteredHolds). An invoice in a payment file stays: a
 * generated file may never have reached the bank.
 */
export function isToPayInList(invoice: ListTabInvoice): boolean {
  if (!PAYABLE.has(invoice.status) || invoice.auto_debit) return false
  const marker = openPaymentMarker(invoice)
  return marker === null || !AT_THE_BANK.has(marker)
}
