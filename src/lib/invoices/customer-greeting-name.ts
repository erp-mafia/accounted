import type { Customer } from '@/types'

type GreetableCustomer = Pick<Customer, 'name' | 'customer_type'> & {
  contact_person?: string | null
}

function firstToken(value: string | null | undefined): string {
  const trimmed = (value ?? '').trim()
  if (!trimmed) return ''
  // Surname-first form ("Svensson, Anna"): one word before the comma and a
  // name after it, so the given name is the first word after the comma.
  // "Anna Svensson, VD" has two words before the comma and keeps "Anna".
  const comma = trimmed.indexOf(',')
  if (comma > 0) {
    const before = trimmed.slice(0, comma).trim().split(/\s+/)
    const after = trimmed.slice(comma + 1).trim().split(/\s+/).filter(Boolean)
    if (before.length === 1 && after.length > 0) return after[0].replace(/[,;:]+$/, '')
  }
  return trimmed.split(/\s+/)[0].replace(/[,;:]+$/, '')
}

/**
 * The name to greet a customer by in email ("Hej Anna,"). Backs the
 * {förnamn} placeholder and the stock greeting.
 *
 * The contact person's first name wins when one is set. Without one, a
 * private individual is greeted by the first word of customers.name. A
 * company is greeted by its full name: the first word of a firm ("Hej
 * Acme," for "Acme Bygg AB") is what this used to produce, and a truncated
 * company name reads as a mistake.
 */
export function customerGreetingName(customer: GreetableCustomer): string {
  const contact = firstToken(customer.contact_person)
  if (contact) return contact
  const name = (customer.name ?? '').trim()
  if (customer.customer_type === 'individual') return firstToken(name)
  return name
}
