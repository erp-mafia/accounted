import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { makeCustomer } from '@/tests/helpers'
import type { Customer } from '@/types'
import { customerFormInitialData } from '../customer-form-initial-data'

/*
 * On an edit CustomerForm submits every field it starts with and sends one it
 * was not given as a clear, so each of them has to come back from the card.
 * The field list is read from the form itself, the keys of its useForm
 * defaultValues: a field added to the form fails here until the starting
 * values carry it.
 */
const formSource = fs.readFileSync(
  path.resolve(__dirname, '../../../components/customers/CustomerForm.tsx'),
  'utf8',
)

function formDefaults(): { field: string; line: string }[] {
  const start = formSource.indexOf('defaultValues: {')
  const end = formSource.indexOf('\n    },', start)
  if (start < 0 || end < start) throw new Error('CustomerForm: the useForm defaultValues object was not found')
  return formSource
    .slice(start, end)
    .split('\n')
    .slice(1)
    .map((line) => ({ field: /^\s*(\w+)\s*:/.exec(line)?.[1] ?? '', line }))
    .filter((entry) => entry.field !== '')
}

const FORM_DEFAULTS = formDefaults()
const FORM_FIELDS = FORM_DEFAULTS.map((entry) => entry.field)

// A card with every field the form submits set to a value of its own.
const card: Customer = makeCustomer({
  name: 'Exempel Bygg AB',
  customer_type: 'swedish_business',
  customer_number: 'K-1042',
  contact_person: 'Inköp',
  email: 'faktura@exempel.se',
  phone: '08-123 456 78',
  invoice_email_cc_addresses: ['ekonomi@exempel.se'],
  invoice_email_bcc_addresses: ['arkiv@exempel.se'],
  address_line1: 'Storgatan 1',
  address_line2: 'Box 12',
  postal_code: '111 22',
  city: 'Stockholm',
  address_state: 'WA',
  country: 'SE',
  org_number: '5566778899',
  vat_number: 'SE556677889901',
  personal_number: '********-1234',
  language: 'en',
  default_payment_terms: 45,
  invoice_reference: 'PO-778',
  invoice_marking: '4500012345',
  notes: 'Fakturera i slutet av månaden.',
})

describe('customerFormInitialData', () => {
  it('names exactly the fields CustomerForm starts with', () => {
    expect(FORM_FIELDS.length).toBeGreaterThan(10)
    expect(Object.keys(customerFormInitialData(card)).sort()).toEqual([...FORM_FIELDS].sort())
  })

  it('is what every one of those fields starts from in the form', () => {
    // A default that ignores initialData would reset the stored value on save.
    for (const { field, line } of FORM_DEFAULTS) {
      expect(line, `${field} starts from initialData`).toContain(`initialData?.${field}`)
    }
  })

  it.each(FORM_FIELDS)('%s comes back as the card stores it', (field) => {
    const stored = card[field as keyof Customer]
    // The card above has to set the field, or a new one would pass unseen.
    expect(stored, `the test card sets ${field}`).not.toBeNull()
    expect(stored, `the test card sets ${field}`).not.toBeUndefined()
    const values: Record<string, unknown> = customerFormInitialData(card)
    expect(values[field]).toEqual(stored)
  })

  it('keeps a stored 0-day term and the card language', () => {
    const values = customerFormInitialData(makeCustomer({ default_payment_terms: 0, language: 'sv' }))
    expect(values.default_payment_terms).toBe(0)
    expect(values.language).toBe('sv')
  })

  it('hands an empty field on as absent, and an empty reference or marking as null', () => {
    const values = customerFormInitialData(
      makeCustomer({
        contact_person: null,
        email: '',
        invoice_email_cc_addresses: null,
        invoice_reference: null,
        invoice_marking: null,
      }),
    )
    expect(values.contact_person).toBeUndefined()
    expect(values.email).toBeUndefined()
    expect(values.invoice_email_cc_addresses).toBeUndefined()
    expect(values.invoice_reference).toBeNull()
    expect(values.invoice_marking).toBeNull()
  })

  it('passes the masked personnummer through: the form leaves a mask out of the save', () => {
    const values = customerFormInitialData(makeCustomer({ customer_type: 'individual', personal_number: '********-????' }))
    expect(values.personal_number).toBe('********-????')
  })
})
