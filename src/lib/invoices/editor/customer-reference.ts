/**
 * Er referens follows the customer card's contact person until the user
 * makes it their own.
 *
 *  - An empty field takes the picked customer's contact person.
 *  - A value the editor filled in itself is replaced when the customer
 *    changes (or cleared when the new one has no contact person), so a
 *    switch never leaves the previous customer's person on the invoice.
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
  /** customers.contact_person of the newly picked customer; null when none is picked. */
  contactPerson: string | null | undefined
}): YourReferencePlan {
  const current = input.current ?? ''
  const contact = input.contactPerson?.trim() ?? ''
  const ownedByUser = current.trim() !== '' && current.trim() !== input.prefilled
  if (ownedByUser) return { value: current, prefilled: null }
  return { value: contact, prefilled: contact || null }
}
