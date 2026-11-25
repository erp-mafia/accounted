import { EMAIL_PATTERN } from '@/lib/invoices/email-recipients'
import {
  mailboxRecipientIdentifiable,
  peppolRecipientIdentifiable,
  type MailboxCustomerFacts,
} from '@/lib/invoices/editor/channel'
import type { CustomerReach, CustomerReachCount } from '@/lib/invoices/send-order'

export interface CustomerContactFacts extends MailboxCustomerFacts {
  email?: string | null
}

/** The three answers for one customer, the ones the invoice editor gives. */
export function customerReach(customer: CustomerContactFacts): CustomerReach {
  const email = customer.email?.trim()
  return {
    peppol: peppolRecipientIdentifiable(customer),
    mailbox: mailboxRecipientIdentifiable(customer),
    email: Boolean(email) && EMAIL_PATTERN.test(email as string),
  }
}

/** How many customers take each combination of the three answers. */
export function countCustomerReach(customers: readonly CustomerContactFacts[]): CustomerReachCount[] {
  const counts = new Map<string, CustomerReachCount>()
  for (const customer of customers) {
    const reach = customerReach(customer)
    const key = `${reach.peppol ? 1 : 0}${reach.mailbox ? 1 : 0}${reach.email ? 1 : 0}`
    const entry = counts.get(key)
    if (entry) entry.count += 1
    else counts.set(key, { reach, count: 1 })
  }
  return [...counts.values()]
}
