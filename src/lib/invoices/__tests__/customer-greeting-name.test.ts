import { describe, expect, it } from 'vitest'
import { customerGreetingName } from '@/lib/invoices/customer-greeting-name'
import { makeCustomer } from '@/tests/helpers'

describe('customerGreetingName', () => {
  it('uses the contact person first name when one is set', () => {
    const customer = makeCustomer({ name: 'Eminos Bygg AB', contact_person: 'Anna Svensson' })
    expect(customerGreetingName(customer)).toBe('Anna')
  })

  it('never truncates a company name to its first word', () => {
    // "Hej Eminos," for a company named "Eminos Bygg AB" was the bug.
    const customer = makeCustomer({ name: 'Eminos Bygg AB', contact_person: null })
    expect(customerGreetingName(customer)).toBe('Eminos Bygg AB')
  })

  it('greets a private individual by first name', () => {
    const customer = makeCustomer({
      name: 'Erik Andersson',
      customer_type: 'individual',
      contact_person: null,
    })
    expect(customerGreetingName(customer)).toBe('Erik')
  })

  it('keeps hyphenated first names, reads surname-first forms, and drops trailing separators', () => {
    expect(customerGreetingName(makeCustomer({ contact_person: 'Anna-Karin Berg' }))).toBe('Anna-Karin')
    expect(customerGreetingName(makeCustomer({ contact_person: 'Svensson, Anna' }))).toBe('Anna')
    expect(customerGreetingName(makeCustomer({ contact_person: 'Svensson, Anna Karin' }))).toBe('Anna')
    expect(customerGreetingName(makeCustomer({ contact_person: '  Anna   Svensson, VD ' }))).toBe('Anna')
    expect(customerGreetingName(makeCustomer({ contact_person: 'Anna,' }))).toBe('Anna')
  })

  it('ignores a whitespace-only contact person', () => {
    const customer = makeCustomer({ name: 'Acme AB', contact_person: '   ' })
    expect(customerGreetingName(customer)).toBe('Acme AB')
  })

  it('returns an empty string when there is nothing to greet by', () => {
    expect(customerGreetingName(makeCustomer({ name: '', customer_type: 'individual', contact_person: null }))).toBe('')
  })
})
