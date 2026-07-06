import { describe, it, expect } from 'vitest'
import { mapCustomer } from '../entity-mapper'
import type { CustomerDto, PartyDto } from '@/lib/providers/dto'

/**
 * Guards customer type inference + identity-number routing in mapCustomer:
 *  - a 12-digit (century-prefixed) Swedish personnummer must read as domestic,
 *    not be misfiled as a foreign org number → non_eu_business (the Johan
 *    Ekengren 19700616-7113 bug);
 *  - an individual's number must land in personal_number (not org_number), or
 *    the individual customer form (which renders personal_number) hides it.
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

  it('provider type=private → individual, personnummer routed to personal_number', () => {
    const row = mapCustomer(makeCustomer({ type: 'private', number: '930722-3207' }), 'u', 'c')
    expect(row.customer_type).toBe('individual')
    expect(row.personal_number).toBe('930722-3207')
    expect(row.org_number).toBeNull()
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
