import type { CreateCustomerInput, Customer } from '@/types'

/**
 * What the customer card's edit form (components/customers/CustomerForm.tsx)
 * starts from: every field it submits, as the row stores it.
 *
 * On an edit the form submits every field and sends one it was not given as
 * '' or [], which the API stores as a clear: a field left out here is wiped
 * by the next save (the contact person and the copy lists once were). The
 * `satisfies` names every key of CreateCustomerInput, the form's own input,
 * so a new field cannot be left out without a type error.
 *
 * Takes the full row (GET /api/customers/[id]), never a picker's list row: a
 * column such a row lacks would reach the form empty and be cleared. The
 * personnummer is the mask every read returns; the form leaves a mask out of
 * what it saves, so an edit that does not retype it never changes it.
 */
export function customerFormInitialData(customer: Customer): Partial<CreateCustomerInput> {
  return {
    name: customer.name,
    customer_type: customer.customer_type,
    customer_number: customer.customer_number || undefined,
    contact_person: customer.contact_person || undefined,
    invoice_email_cc_addresses: customer.invoice_email_cc_addresses ?? undefined,
    invoice_email_bcc_addresses: customer.invoice_email_bcc_addresses ?? undefined,
    email: customer.email || undefined,
    phone: customer.phone || undefined,
    address_line1: customer.address_line1 || undefined,
    address_line2: customer.address_line2 || undefined,
    postal_code: customer.postal_code || undefined,
    city: customer.city || undefined,
    address_state: customer.address_state || undefined,
    country: customer.country || undefined,
    org_number: customer.org_number || undefined,
    vat_number: customer.vat_number || undefined,
    personal_number: customer.personal_number || undefined,
    // The form starts an omitted language on 'sv', so it would reset on save.
    language: customer.language,
    // ?? not ||: a stored 0 (betalning direkt) is a term.
    default_payment_terms: customer.default_payment_terms ?? undefined,
    invoice_reference: customer.invoice_reference,
    invoice_marking: customer.invoice_marking,
    // A way left out would reach the form as "follow the company's order" and be cleared on save.
    invoice_send_way: customer.invoice_send_way ?? null,
    notes: customer.notes || undefined,
  } satisfies Record<keyof CreateCustomerInput, unknown>
}
