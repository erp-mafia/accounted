import { customerInvoiceReference } from '@/lib/customers/invoice-reference'
import { customerInvoiceMarking } from '@/lib/customers/invoice-marking'

/**
 * Er referens follows the customer card until the user makes it their own.
 *
 *  - An empty field takes the picked customer's reference
 *    (customerCardReference: its Fakturareferens, else its contact person).
 *  - A value the editor filled in itself is replaced when the customer
 *    changes (or cleared when the new one has no reference), so a switch
 *    never leaves the previous customer's reference on the invoice.
 *  - Anything else in the field was typed by the user, or came from a copy
 *    or a saved draft: it is never overwritten.
 *
 * Pure: the editor keeps `prefilled` between customer changes.
 */
export interface YourReferencePlan {
  /** What the Er referens field should hold. */
  value: string
  /** The value the editor filled in itself; null once the field is the user's. */
  prefilled: string | null
}

export function planYourReferencePrefill(input: {
  /** The field as it is now. */
  current: string | null | undefined
  /** What the editor filled in last time; null when it filled in nothing. */
  prefilled: string | null
  /** customerCardReference of the newly picked customer; null when none is picked. */
  customerReference: string | null | undefined
}): YourReferencePlan {
  const current = input.current ?? ''
  const contact = input.customerReference?.trim() ?? ''
  const ownedByUser = current.trim() !== '' && current.trim() !== input.prefilled
  if (ownedByUser) return { value: current, prefilled: null }
  return { value: contact, prefilled: contact || null }
}

/**
 * Whether Er referens should be planned again: only when the picked customer
 * differs from the one the field last followed. The editor's customer effect
 * also re-runs when the customer list refreshes, and a refresh must neither
 * refill a field the user emptied nor fill a saved draft's empty value.
 */
export function customerChangedForReference(
  followedCustomerId: string | null | undefined,
  customerId: string | null | undefined,
): boolean {
  return (followedCustomerId || null) !== (customerId || null)
}

/**
 * What the editor fills Er referens with for a customer: the card's
 * Fakturareferens (crm#1200), else its contact person. The Fakturareferens
 * wins because it is the one field kept for exactly this purpose, often a
 * cost centre or reference code the buyer routes the invoice by (Peppol
 * BT-10); the contact person was only the best guess before it existed. A
 * customer without a Fakturareferens prefills exactly as before.
 */
export function customerCardReference(
  customer: { invoice_reference?: string | null; contact_person?: string | null } | null | undefined,
): string | null {
  return customerInvoiceReference(customer) ?? (customer?.contact_person?.trim() || null)
}

/**
 * Märkning follows the customer card by the same rule (crm#1477): the card's
 * Märkning into an empty field, replaced on a customer switch only while it
 * is still the editor's own, never over what the user typed. It shares the
 * Er referens gate (customerChangedForReference), so a refreshed customer
 * list or a saved draft's own customer never refills it either.
 */
export function planMarkingPrefill(input: {
  /** The Märkning field as it is now. */
  current: string | null | undefined
  /** What the editor filled in last time; null when it filled in nothing. */
  prefilled: string | null
  /** The newly picked customer; null when none is picked. */
  customer: { invoice_marking?: string | null } | null | undefined
}): YourReferencePlan {
  return planYourReferencePrefill({
    current: input.current,
    prefilled: input.prefilled,
    customerReference: customerInvoiceMarking(input.customer),
  })
}

/** The card fields Er referens and Märkning are filled from. */
interface CardReferenceSources {
  invoice_reference?: string | null
  contact_person?: string | null
  invoice_marking?: string | null
}

/**
 * After the picked customer's card is saved from the editor: which of Er
 * referens and Märkning to plan again. Each only when its card source changed
 * in that save (customerCardReference, the card's Märkning), so an edit of
 * the address leaves both as they are, an emptied field included.
 */
export function cardEditReplans(
  before: CardReferenceSources,
  after: CardReferenceSources,
): { reference: boolean; marking: boolean } {
  return {
    reference: customerCardReference(before) !== customerCardReference(after),
    marking: customerInvoiceMarking(before) !== customerInvoiceMarking(after),
  }
}
