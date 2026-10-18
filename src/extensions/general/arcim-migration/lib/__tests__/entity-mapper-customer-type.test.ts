import { describe, it, expect } from 'vitest'
import { customerIdentityColumns, invoiceStubCustomerType, mapCustomer } from '../entity-mapper'
import { decryptPersonnummer } from '@/lib/salary/personnummer'
import type { CustomerDto, PartyDto } from '@/lib/providers/dto'

/**
 * Guards customer type inference + identity-number routing in mapCustomer:
 *  - a 12-digit (century-prefixed) Swedish personnummer must read as domestic,
 *    not be misfiled as a foreign org number → non_eu_business (the Johan
 *    Ekengren 19700616-7113 bug);
 *  - an individual's number must land in personal_number (not org_number), or
 *    the individual customer form (which renders personal_number) hides it,
 *    and it must be ENCRYPTED on the way in: the column takes ciphertext only.
 */

function makeCustomer(over: {
  type?: 'company' | 'private'
  number?: string | null
  vatNumber?: string
  name?: string
  countryCode?: string
}): CustomerDto {
  const party: PartyDto = {
    name: over.name ?? 'Test Kund',
    identifications: over.number ? [{ schemeId: 'SE:ORGNR', id: over.number }] : [],
    postalAddress: over.countryCode ? { countryCode: over.countryCode } : undefined,
  }
  return {
    id: 'cust-1',
    customerNumber: '1',
    type: over.type,
    party,
    active: true,
    vatNumber: over.vatNumber,
    defaultPaymentTermsDays: 30,
  }
}

describe('mapCustomer: type inference & identity-number routing', () => {
  it('12-digit personnummer (no VAT, provider type=company) → swedish_business, not non_eu', () => {
    const row = mapCustomer(makeCustomer({ type: 'company', number: '19700616-7113' }), 'u', 'c')
    expect(row.customer_type).toBe('swedish_business')
    expect(row.org_number).toBe('19700616-7113')
    expect(row.personal_number).toBeNull()
  })

  it('provider type=private → individual, personnummer encrypted into personal_number', () => {
    // personal_number is an encrypted column. customers_personal_number_check
    // (migration 20260726110000) accepts AES-256-GCM hex and nothing else, so
    // the plaintext this used to assert would abort the whole import with
    // 23514 the moment a Privatperson appeared in the source data.
    const row = mapCustomer(makeCustomer({ type: 'private', number: '930722-3207' }), 'u', 'c')
    expect(row.customer_type).toBe('individual')
    expect(row.org_number).toBeNull()

    const stored = row.personal_number as string
    expect(stored).not.toBe('930722-3207')
    expect(stored).toMatch(/^[0-9a-f]{76,255}$/)
    expect(decryptPersonnummer(stored)).toBe('930722-3207')
  })

  it('leaves personal_number null for a business, with nothing to encrypt', () => {
    const row = mapCustomer(makeCustomer({ type: 'company', number: '556055-1234' }), 'u', 'c')
    expect(row.personal_number).toBeNull()
  })

  it('10-digit personnummer (provider type=company) still → swedish_business (unchanged)', () => {
    const row = mapCustomer(makeCustomer({ type: 'company', number: '930722-3207' }), 'u', 'c')
    expect(row.customer_type).toBe('swedish_business')
    expect(row.org_number).toBe('930722-3207')
  })

  it('10-digit org number → swedish_business', () => {
    const row = mapCustomer(makeCustomer({ type: 'company', number: '556055-1234' }), 'u', 'c')
    expect(row.customer_type).toBe('swedish_business')
  })

  it('non-Swedish-format number → non_eu_business', () => {
    const row = mapCustomer(makeCustomer({ type: 'company', number: '12345678' }), 'u', 'c')
    expect(row.customer_type).toBe('non_eu_business')
  })

  it('EU VAT prefix wins over number heuristics → eu_business', () => {
    const row = mapCustomer(makeCustomer({ type: 'company', vatNumber: 'DE123456789' }), 'u', 'c')
    expect(row.customer_type).toBe('eu_business')
  })
})

/**
 * An invoice's customer carries no private/company type: the migration builds
 * its stub from the invoice alone (mapCustomer with no `type`). A
 * personnummer used to land in plaintext in org_number on a swedish_business
 * stub; it now makes the stub a privatperson with the number encrypted.
 */
describe('mapCustomer: an untyped invoice stub', () => {
  const stub = (over: { number?: string | null; vatNumber?: string; countryCode?: string; name?: string }) =>
    makeCustomer({ ...over, type: undefined })

  it('stores a 12-digit personnummer encrypted on a privatperson, never in org_number', () => {
    const row = mapCustomer(stub({ number: '19850101-1234', name: 'Anna Andersson' }), 'u', 'c')

    expect(row.customer_type).toBe('individual')
    expect(row.org_number).toBeNull()
    expect(row.personal_number).toMatch(/^[0-9a-f]{76,255}$/)
    expect(decryptPersonnummer(row.personal_number as string)).toBe('19850101-1234')
    expect(JSON.stringify(row)).not.toContain('1985010')
  })

  it('reads Fortnox\'s country name: a 10-digit personnummer in "Sverige" is a privatperson too', () => {
    const row = mapCustomer(stub({ number: '850101-1234', countryCode: 'Sverige' }), 'u', 'c')

    expect(row.customer_type).toBe('individual')
    expect(row.org_number).toBeNull()
    expect(decryptPersonnummer(row.personal_number as string)).toBe('850101-1234')
  })

  it('treats a samordningsnummer (day + 60) the same way', () => {
    const row = mapCustomer(stub({ number: '850161-1234' }), 'u', 'c')

    expect(row.customer_type).toBe('individual')
    expect(row.org_number).toBeNull()
  })

  it('keeps an organisationsnummer on a business, unencrypted: the normal path is unchanged', () => {
    const row = mapCustomer(stub({ number: '556055-1234' }), 'u', 'c')
    expect(row.customer_type).toBe('swedish_business')
    expect(row.org_number).toBe('556055-1234')
    expect(row.personal_number).toBeNull()

    // The 16-prefixed 12-digit form is an organisationsnummer, not a person.
    const prefixed = mapCustomer(stub({ number: '165560551234' }), 'u', 'c')
    expect(prefixed.customer_type).not.toBe('individual')
    expect(prefixed.org_number).toBe('165560551234')
    expect(prefixed.personal_number).toBeNull()
  })

  it('keeps a personnummer with a VAT number on a business: an enskild firma registered for VAT', () => {
    const row = mapCustomer(stub({ number: '850101-1234', vatNumber: 'SE850101123401' }), 'u', 'c')

    expect(row.customer_type).toBe('swedish_business')
    expect(row.org_number).toBe('850101-1234')
    expect(row.personal_number).toBeNull()
  })

  it('leaves a number under a foreign country to the foreign rules', () => {
    const row = mapCustomer(stub({ number: '850101-1234', countryCode: 'NO' }), 'u', 'c')

    expect(row.customer_type).toBe('non_eu_business')
    expect(row.personal_number).toBeNull()
  })

  it('a register record the source typed company keeps its personnummer as the enskild firma org number', () => {
    const row = mapCustomer(makeCustomer({ type: 'company', number: '850101-1234' }), 'u', 'c')

    expect(row.customer_type).toBe('swedish_business')
    expect(row.org_number).toBe('850101-1234')
  })
})

describe('invoiceStubCustomerType and customerIdentityColumns (the legacy stub path)', () => {
  const party = (number: string | null, countryCode?: string): PartyDto => ({
    name: 'Kund',
    identifications: number ? [{ schemeId: 'SE:ORGNR', id: number }] : [],
    postalAddress: countryCode ? { countryCode } : undefined,
  })

  it('types a personnummer party as a privatperson and an org-numbered one as a business', () => {
    expect(invoiceStubCustomerType(party('19850101-1234'))).toBe('individual')
    expect(invoiceStubCustomerType(party('556055-1234'))).toBe('swedish_business')
    expect(invoiceStubCustomerType(party(null))).toBe('swedish_business')
    expect(invoiceStubCustomerType(party('850101-1234', 'DE'))).toBe('eu_business')
  })

  it('routes the number to the column its type expects', () => {
    const person = customerIdentityColumns('individual', '19850101-1234')
    expect(person.org_number).toBeNull()
    expect(decryptPersonnummer(person.personal_number as string)).toBe('19850101-1234')

    expect(customerIdentityColumns('swedish_business', '556055-1234')).toEqual({
      org_number: '556055-1234',
      personal_number: null,
    })
    // Too short to be a personnummer: omitted, never plaintext anywhere.
    expect(customerIdentityColumns('individual', '850101')).toEqual({ org_number: null, personal_number: null })
  })
})
