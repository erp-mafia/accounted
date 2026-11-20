/**
 * The registration the supplier-invoice editor has submitted and not yet
 * sent: it waits for a bank row to be picked, for the review dialog, or for
 * both.
 *
 * One value with one writer, so a bank row cannot outlive the submit it was
 * picked for. The editor held the submitted form and the picked row in two
 * states, and a new submit replaced the form only: a person who picked a row
 * for "Företaget", stepped back from the review, switched to "Ingen ännu" and
 * registered got the unpaid invoice attested, matched to that row and marked
 * paid.
 */
import type { SupplierInvoiceFormData } from './form-payload'

export interface PendingRegistration {
  /** The form as it was submitted. */
  data: SupplierInvoiceFormData
  /**
   * The bank row the registration is settled against: the row the Inkorg
   * already matched the document to, or the one picked for this submit.
   * Null for every registration the company has not paid.
   */
  transactionId: string | null
}

export type PendingRegistrationEvent =
  /** The form was submitted. knownTransactionId: the bank row the Inkorg matched on arrival, if any. */
  | { type: 'submitted'; data: SupplierInvoiceFormData; knownTransactionId: string | null }
  /** A bank row was picked for the submitted registration. */
  | { type: 'row_picked'; transactionId: string }

/** Only a registration the company paid is settled against a bank row. */
const companyPaid = (data: SupplierInvoiceFormData): boolean => data.payer === 'company'

export function pendingRegistrationReducer(
  pending: PendingRegistration | null,
  event: PendingRegistrationEvent,
): PendingRegistration | null {
  switch (event.type) {
    case 'submitted':
      // A new submit is a new registration: nothing of the one before it
      // comes along, least of all the bank row picked for it.
      return { data: event.data, transactionId: companyPaid(event.data) ? event.knownTransactionId : null }
    case 'row_picked':
      return pending && companyPaid(pending.data) ? { ...pending, transactionId: event.transactionId } : pending
  }
}
