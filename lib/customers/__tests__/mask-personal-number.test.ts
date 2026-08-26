import { describe, expect, it } from 'vitest'
import {
  PERSONAL_NUMBER_PLAINTEXT_RE,
  UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
  customerListIdentifier,
} from '@/lib/customers/mask-personal-number'

// Synthetic personnummer throughout, never a real one.
describe('customerListIdentifier', () => {
  it('shows org_number for business rows', () => {
    expect(customerListIdentifier({ customer_type: 'swedish_business', org_number: '556677-8899' })).toBe('556677-8899')
    expect(customerListIdentifier({ customer_type: 'swedish_business', org_number: null })).toBe('')
  })

  it('shows the masked personal_number for individual rows, passing an API mask through', () => {
    expect(customerListIdentifier({ customer_type: 'individual', personal_number: '********-1234' })).toBe('********-1234')
    expect(customerListIdentifier({ customer_type: 'individual', personal_number: '19900101-1234' })).toBe('********-1234')
    expect(
      customerListIdentifier({ customer_type: 'individual', personal_number: UNDECRYPTABLE_PERSONAL_NUMBER_MASK }),
    ).toBe(UNDECRYPTABLE_PERSONAL_NUMBER_MASK)
  })

  it('masks a legacy individual row that still carries its personnummer in org_number', () => {
    expect(customerListIdentifier({ customer_type: 'individual', org_number: '19900101-1234', personal_number: null })).toBe(
      '********-1234',
    )
  })

  it('leaves a non-personnummer org_number on an individual visible', () => {
    expect(customerListIdentifier({ customer_type: 'individual', org_number: 'CHE-123.456.789' })).toBe('CHE-123.456.789')
    expect(customerListIdentifier({ customer_type: 'individual' })).toBe('')
  })
})

describe('PERSONAL_NUMBER_PLAINTEXT_RE', () => {
  it('accepts the four written forms and nothing else', () => {
    for (const value of ['900101-1234', '900101+1234', '19900101-1234', '9001011234', '199001011234']) {
      expect(PERSONAL_NUMBER_PLAINTEXT_RE.test(value)).toBe(true)
    }
    // Shape only: a legal-entity orgnr with a dash has the same digit shape
    // and is kept out by looksLikeSwedishPersonalNumber at the call sites,
    // not by this regex.
    for (const value of ['********-1234', '********-????', '19900101 1234', 'abc', '1234']) {
      expect(PERSONAL_NUMBER_PLAINTEXT_RE.test(value)).toBe(false)
    }
  })
})
