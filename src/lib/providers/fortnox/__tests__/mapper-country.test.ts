import { describe, expect, it } from 'vitest'
import { mapFortnoxToCustomer, mapFortnoxToSalesInvoice, mapFortnoxToSupplier } from '../mapper'

// A Fortnox customer or supplier record names its country twice: CountryCode
// (ISO) and Country, the name Fortnox shows. The code is read first; an
// invoice carries only the name (crm#1436).
describe('Fortnox country mapping', () => {
  it('reads CountryCode before the country name', () => {
    const dto = mapFortnoxToSupplier({ SupplierNumber: '7', Name: 'Lieferant', Country: 'Deutschland', CountryCode: 'DE' })
    expect(dto.party.postalAddress?.countryCode).toBe('DE')
  })

  it('reads CountryCode when the record has no name', () => {
    const dto = mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Kund', CountryCode: 'NO' })
    expect(dto.party.postalAddress?.countryCode).toBe('NO')
  })

  it('falls back to the name when the code is empty', () => {
    const dto = mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Kund AB', Country: 'Sverige', CountryCode: ' ' })
    expect(dto.party.postalAddress?.countryCode).toBe('Sverige')
  })

  it('keeps the name on an invoice, which has no code', () => {
    const dto = mapFortnoxToSalesInvoice({ DocumentNumber: '1001', CustomerName: 'Kund AS', Country: 'Norge', InvoiceDate: '2026-09-01' })
    expect(dto.customer.postalAddress?.countryCode).toBe('Norge')
  })
})
