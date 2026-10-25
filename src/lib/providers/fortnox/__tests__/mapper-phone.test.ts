import { describe, expect, it } from 'vitest'
import { mapFortnoxToCustomer, mapFortnoxToSupplier } from '../mapper'

// Fortnox names the number Phone1 on a single customer or supplier and Phone
// in their lists (crm#1436).
describe('Fortnox phone mapping', () => {
  it('reads Phone from a listed customer', () => {
    const dto = mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Kund AB', Phone: '08-123 45 67' })
    expect(dto.party.contact?.telephone).toBe('08-123 45 67')
  })

  it('reads Phone from a listed supplier', () => {
    const dto = mapFortnoxToSupplier({ SupplierNumber: '1', Name: 'Leverantör AB', Phone: '070-123 45 67' })
    expect(dto.party.contact?.telephone).toBe('070-123 45 67')
  })

  it('prefers Phone1 from the single record', () => {
    const dto = mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Kund AB', Phone1: '08-111', Phone: '08-222' })
    expect(dto.party.contact?.telephone).toBe('08-111')
  })

  it('falls back to Phone when Phone1 is empty', () => {
    const dto = mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Kund AB', Phone1: ' ', Phone: '08-222' })
    expect(dto.party.contact?.telephone).toBe('08-222')
  })

  it('leaves the phone out when neither is set', () => {
    const dto = mapFortnoxToSupplier({ SupplierNumber: '1', Name: 'Leverantör AB', Phone: '' })
    expect(dto.party.contact?.telephone).toBeUndefined()
  })
})
