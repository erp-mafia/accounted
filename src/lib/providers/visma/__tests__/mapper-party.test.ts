import { describe, expect, it } from 'vitest'
import { mapVismaToCustomer, mapVismaToSupplier } from '../mapper'

/**
 * The field names are eAccounting's own (CustomerApi and SupplierApi in its
 * OpenAPI document, /v2). The mapper read CountryCode for a customer, which
 * names it InvoiceCountryCode, and BankGiro/PlusGiro for a supplier, which
 * names them BankgiroNumber/PlusgiroNumber, and never read the VAT number:
 * 1% of imported Visma customers had a country (crm#1436).
 */

const CUSTOMER = {
  Id: 'c0ffee00-0000-0000-0000-000000000001',
  CustomerNumber: '1001',
  Name: 'Kunde GmbH',
  IsPrivatePerson: false,
  IsActive: true,
  InvoiceAddress1: 'Hauptstrasse 1',
  InvoicePostalCode: '10115',
  InvoiceCity: 'Berlin',
  InvoiceCountryCode: 'DE',
  EmailAddress: 'rechnung@example.test',
  EmailAddresses: ['kopia@example.test', ' '],
  Telephone: '',
  MobilePhone: '+49 151 123',
  ContactPersonName: 'Anna Exempel',
  VatNumber: 'DE123456789',
  TermsOfPayment: { Id: 't-1', Name: '20 dagar', NumberOfDays: 20, TermsOfPaymentTypeId: 0 },
  Note: 'Fakturera i EUR',
  ChangedUtc: '2026-10-01T10:00:00Z',
}

const SUPPLIER = {
  Id: 'c0ffee00-0000-0000-0000-000000000002',
  SupplierNumber: '7',
  Name: 'Leverantör AB',
  IsActive: true,
  CorporateIdentityNumber: '556677-8899',
  Address1: 'Gatan 1',
  PostalCode: '111 22',
  City: 'Stockholm',
  CountryCode: 'SE',
  EmailAddress: 'info@example.test',
  Telephone: '08-123 45 67',
  VatNumber: 'SE556677889901',
  BankAccountNumber: '1234-5678901',
  BankgiroNumber: '123-4567',
  PlusgiroNumber: '12345-6',
  Note: 'Ramavtal 2026',
  ModifiedUtc: '2026-10-01T10:00:00Z',
}

describe('Visma customer', () => {
  it('reads the country from InvoiceCountryCode', () => {
    expect(mapVismaToCustomer(CUSTOMER).party.postalAddress).toEqual({
      streetName: 'Hauptstrasse 1', additionalStreetName: undefined, cityName: 'Berlin', postalZone: '10115', countryCode: 'DE',
    })
  })

  it('reads the VAT number, the contact person, the CC addresses and the note', () => {
    const dto = mapVismaToCustomer(CUSTOMER)
    expect(dto.vatNumber).toBe('DE123456789')
    expect(dto.party.contact).toMatchObject({ name: 'Anna Exempel', email: 'rechnung@example.test' })
    expect(dto.invoiceEmailCcAddresses).toEqual(['kopia@example.test'])
    expect(dto.note).toBe('Fakturera i EUR')
  })

  it('takes the mobile number when the record has no landline', () => {
    expect(mapVismaToCustomer(CUSTOMER).party.contact?.telephone).toBe('+49 151 123')
    expect(mapVismaToCustomer({ ...CUSTOMER, Telephone: '08-1' }).party.contact?.telephone).toBe('08-1')
  })

  it('reads Normal terms as days and leaves the others to the default', () => {
    expect(mapVismaToCustomer(CUSTOMER).defaultPaymentTermsDays).toBe(20)
    expect(mapVismaToCustomer({ ...CUSTOMER, TermsOfPayment: { NumberOfDays: 0, TermsOfPaymentTypeId: 0 } }).defaultPaymentTermsDays).toBe(0)
    // CurrentMonth: 30 days from the end of the month, not 30 days net.
    expect(mapVismaToCustomer({ ...CUSTOMER, TermsOfPayment: { NumberOfDays: 30, TermsOfPaymentTypeId: 1 } }).defaultPaymentTermsDays).toBeUndefined()
    expect(mapVismaToCustomer({ ...CUSTOMER, TermsOfPayment: null }).defaultPaymentTermsDays).toBeUndefined()
  })

  it('leaves out what the record does not carry', () => {
    const dto = mapVismaToCustomer({ Id: 'c-2', CustomerNumber: '2', Name: 'Kund', IsActive: true })
    expect(dto.party.postalAddress?.countryCode).toBeUndefined()
    expect(dto.vatNumber).toBeUndefined()
    expect(dto.invoiceEmailCcAddresses).toBeUndefined()
    expect(dto.defaultPaymentTermsDays).toBeUndefined()
    expect(dto.party.contact).toEqual({ name: undefined, email: undefined, telephone: undefined })
  })
})

describe('Visma supplier', () => {
  it('reads bankgiro and plusgiro under the names SupplierApi gives them', () => {
    const dto = mapVismaToSupplier(SUPPLIER)
    expect(dto).toMatchObject({ bankGiro: '123-4567', plusGiro: '12345-6', bankAccount: '1234-5678901' })
  })

  it('reads the country, the VAT number, the phone and the note', () => {
    const dto = mapVismaToSupplier(SUPPLIER)
    expect(dto.party.postalAddress?.countryCode).toBe('SE')
    expect(dto.vatNumber).toBe('SE556677889901')
    expect(dto.party.contact).toMatchObject({ email: 'info@example.test', telephone: '08-123 45 67' })
    expect(dto.note).toBe('Ramavtal 2026')
  })
})
