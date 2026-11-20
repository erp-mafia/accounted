import { describe, expect, it } from 'vitest'
import {
  PERSONAL_NUMBER_PLAINTEXT_RE,
  UNDECRYPTABLE_PERSONAL_NUMBER_MASK,
  agentCustomerIdentifiers,
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

  it('masks the org_number of an enskild firma stored as a Swedish business (#2367)', () => {
    expect(customerListIdentifier({ customer_type: 'swedish_business', org_number: '19900101-1234' })).toBe(
      '********-1234',
    )
    expect(customerListIdentifier({ customer_type: 'swedish_business', org_number: '9001011234' })).toBe(
      '********-1234',
    )
  })

  it('masks a legacy foreign-business row that carries a personnummer in org_number (#95)', () => {
    expect(customerListIdentifier({ customer_type: 'eu_business', org_number: '19900101-1234' })).toBe(
      '********-1234',
    )
    expect(customerListIdentifier({ customer_type: 'non_eu_business', org_number: '199001011234' })).toBe(
      '********-1234',
    )
  })

  it('leaves a foreign business registration number alone', () => {
    expect(customerListIdentifier({ customer_type: 'eu_business', org_number: '923609016' })).toBe('923609016')
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

describe('agentCustomerIdentifiers', () => {
  it("masks an enskild firma's org number and nulls the VAT number built on it (#95)", () => {
    expect(agentCustomerIdentifiers({ org_number: '900101-1234', vat_number: 'SE900101123401' }, null)).toEqual({
      org_number: null,
      vat_number: null,
      personal_number_masked: '********-1234',
    })
  })

  it("keeps a company's org and VAT numbers", () => {
    expect(agentCustomerIdentifiers({ org_number: '556677-8899', vat_number: 'SE556677889901' }, null)).toEqual({
      org_number: '556677-8899',
      vat_number: 'SE556677889901',
      personal_number_masked: null,
    })
  })

  it("passes an individual's already-masked personal_number through", () => {
    expect(agentCustomerIdentifiers({ org_number: null, vat_number: null }, '********-1234')).toEqual({
      org_number: null,
      vat_number: null,
      personal_number_masked: '********-1234',
    })
  })
})
