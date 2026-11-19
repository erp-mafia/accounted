import { describe, expect, it } from 'vitest'
import { listedMatchNumber, storedMatchNumber } from '../lib/supplier-invoice-identity'

describe('supplier invoice identity', () => {
  it('matches a Fortnox record on its löpnummer and any other on the supplier number', () => {
    expect(listedMatchNumber('fortnox', { id: '367', invoiceNumber: '21879926' })).toBe('367')
    expect(listedMatchNumber('visma', { id: 'guid-1', invoiceNumber: '21879926' })).toBe('21879926')
    expect(storedMatchNumber('fortnox', { supplier_invoice_number: '21879926', fortnox_number: '367' })).toBe('367')
    expect(storedMatchNumber('fortnox', { supplier_invoice_number: '367', fortnox_number: null })).toBe('367')
    expect(storedMatchNumber('visma', { supplier_invoice_number: '21879926', fortnox_number: '367' })).toBe('21879926')
  })

  it('falls back to the supplier number for a Fortnox record without a löpnummer', () => {
    expect(listedMatchNumber('fortnox', { id: ' ', invoiceNumber: '21879926' })).toBe('21879926')
  })
})
