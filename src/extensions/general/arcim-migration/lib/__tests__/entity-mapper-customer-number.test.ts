import { describe, expect, it } from 'vitest'
import type { CustomerDto } from '@/lib/providers/dto'
import { mapFortnoxToCustomer } from '@/lib/providers/fortnox/mapper'
import { mapVismaToCustomer } from '@/lib/providers/visma/mapper'
import { mapBokioToCustomer } from '@/lib/providers/bokio/mapper'
import { mapBrioxToCustomer } from '@/lib/providers/briox/mapper'
import { mapBLToCustomer } from '@/lib/providers/bjornlunden/mapper'
import { mapWintToCustomer } from '@/lib/providers/wint/mapper'
import { mapCustomer, providerCustomerNumber } from '../entity-mapper'

/**
 * A migrated customer keeps the customer number (kundnummer) it had at the
 * source, the number its invoices print (crm#1744). The import dropped it, so
 * every migrated customer arrived with customer_number null. The commit
 * writes every key of the mapped row (insert_provider_migration_row), so the
 * key on the row is what lands.
 */

const number = (provider: string, dto: CustomerDto) => mapCustomer(dto, 'u', 'c', provider).customer_number

describe('mapCustomer: the customer number', () => {
  it('writes Fortnox\'s and Visma\'s CustomerNumber', () => {
    expect(number('fortnox', mapFortnoxToCustomer({ CustomerNumber: '1001', Name: 'Kund AB' }))).toBe('1001')
    expect(number('visma', mapVismaToCustomer({ Id: '6f1c9a52-0000-4000-8000-000000000001', CustomerNumber: '27', Name: 'Kund AB' })))
      .toBe('27')
  })

  it('writes Briox\'s customer_number, never its id', () => {
    expect(number('briox', mapBrioxToCustomer({ id: 88, customer_number: 'K-12', name: 'Kund AB' }))).toBe('K-12')
    expect(number('briox', mapBrioxToCustomer({ id: 88, name: 'Kund AB' }))).toBeNull()
  })

  it('writes Bokio\'s customerNumber, never the record id its mapper hands over as one', () => {
    const dto = mapBokioToCustomer({ id: '55c899c5-82b2-47fa-9c51-e35fc9b26443', customerNumber: '17', name: 'Kund AB' })
    expect(dto.customerNumber).toBe('55c899c5-82b2-47fa-9c51-e35fc9b26443')
    expect(number('bokio', dto)).toBe('17')
    expect(number('bokio', mapBokioToCustomer({ id: '55c899c5-82b2-47fa-9c51-e35fc9b26443', name: 'Kund AB' }))).toBeNull()
  })

  it('writes none for a provider whose id is not known to be the number the user sees', () => {
    expect(number('bjornlunden', mapBLToCustomer({ entityId: 1, id: 1001, name: 'Kund AB' }))).toBeNull()
    expect(number('wint', mapWintToCustomer({ Id: 42, Name: 'Kund AB' }))).toBeNull()
  })

  it('writes none without a provider, and a stub without a number gets none', () => {
    const dto = mapFortnoxToCustomer({ CustomerNumber: '1001', Name: 'Kund AB' })
    expect(mapCustomer(dto, 'u', 'c')).toHaveProperty('customer_number', null)
    expect(number('fortnox', { id: '', customerNumber: '', active: true, party: { name: 'Kund AB', identifications: [] } })).toBeNull()
  })
})

describe('providerCustomerNumber: normalised like the customer form', () => {
  const fortnox = (customerNumber: string): CustomerDto =>
    ({ id: customerNumber, customerNumber, active: true, party: { name: 'Kund AB', identifications: [] } })

  it('trims, and reads a blank number as none', () => {
    expect(providerCustomerNumber('fortnox', fortnox('  1001 '))).toBe('1001')
    expect(providerCustomerNumber('fortnox', fortnox('   '))).toBeNull()
  })

  it('leaves out a number longer than the form accepts rather than cutting it', () => {
    expect(providerCustomerNumber('fortnox', fortnox('9'.repeat(32)))).toBe('9'.repeat(32))
    expect(providerCustomerNumber('fortnox', fortnox('9'.repeat(33)))).toBeNull()
  })

  it('reads a number a provider sends as a JSON number', () => {
    expect(providerCustomerNumber('bokio', { ...fortnox(''), _raw: { customerNumber: 17 } })).toBe('17')
    expect(providerCustomerNumber('briox', { ...fortnox(''), _raw: { customernumber: 5 } })).toBe('5')
  })
})
