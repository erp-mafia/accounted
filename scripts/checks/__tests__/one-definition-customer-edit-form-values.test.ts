/**
 * The guard of the customer edit form's starting values: they are built from
 * the stored row in one place, so a second edit door cannot leave a field out
 * and wipe it on save.
 */
import { describe, it, expect } from 'vitest'
import { findRuleLines } from '../one-definition.mjs'
import rule from '../one-definition/customer-edit-form-values.mjs'

const hits = (line: string) => findRuleLines(line, rule).length > 0

describe('customer-edit-form-values', () => {
  it.each([
    // The customer page's dialog as it was.
    'contact_person: customer.contact_person || undefined,',
    'invoice_email_cc_addresses: customer.invoice_email_cc_addresses ?? undefined,',
    'default_payment_terms: customer.default_payment_terms ?? undefined,',
    // The same from a nested or optional row.
    'phone: row.customer?.phone || undefined,',
    'city: customer?.city || undefined,',
  ])('flags: %s', (line) => {
    expect(hits(line)).toBe(true)
  })

  it.each([
    // Another field, or another default, is not a form's starting value.
    'vat: customer.vat_number || undefined,',
    'email: customer.email ?? null,',
    "country: customer.country || 'SE',",
    // The form's own submit and a display of the card.
    "contact_person: data.contact_person?.trim() || (isEditing ? '' : null),",
    '{customer.contact_person && (',
    'name: customer.name,',
  ])('leaves: %s', (line) => {
    expect(hits(line)).toBe(false)
  })
})
