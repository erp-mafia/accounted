import { describe, it, expect } from 'vitest'
import { inferTypeFromParty, invoiceStubCustomerType, mapCustomer, mapSupplier, partyCountry } from '../entity-mapper'
import { mapFortnoxToCustomer, mapFortnoxToSalesInvoice, mapFortnoxToSupplier } from '@/lib/providers/fortnox/mapper'
import { mapBrioxToCustomer, mapBrioxToSupplier } from '@/lib/providers/briox/mapper'
import { mapBLToCustomer, mapBLToSupplier } from '@/lib/providers/bjornlunden/mapper'
import { mapBokioToCustomer, mapBokioToSupplier } from '@/lib/providers/bokio/mapper'
import { mapVismaToCustomer, mapVismaToSupplier } from '@/lib/providers/visma/mapper'
import { mapWintToCustomer } from '@/lib/providers/wint/mapper'
import type { PartyDto } from '@/lib/providers/dto'

/**
 * The migration typed a customer or supplier from the RAW country while it
 * stored the normalised one. Fortnox writes the country by name ("Sverige"),
 * which is neither "SE" nor an EU code, so a Swedish party was typed
 * non_eu_business beside country SE, and every new invoice to it was locked
 * to 0 % export (supplier invoices defaulted to reverse charge). The country
 * is now read once, the same way for the column and for the type.
 */

describe('partyCountry: one reading for the column and the type', () => {
  it.each([
    ['SE', 'SE'],
    ['se', 'SE'],
    [' SE ', 'SE'],
    ['Sverige', 'SE'],
    ['SVERIGE', 'SE'],
    ['sverige ', 'SE'],
    ['Sweden', 'SE'],
    ['SWE', 'SE'],
    ['swe', 'SE'],
    ['Tyskland', 'DE'],
    ['Germany', 'DE'],
    ['EL', 'GR'],
    ['Norge', 'NO'],
    ['Norway', 'NO'],
  ])('%j reads as %s', (raw, code) => {
    expect(partyCountry(raw)).toBe(code)
  })

  it('treats an empty value as no country', () => {
    expect(partyCountry('')).toBeNull()
    expect(partyCountry('   ')).toBeNull()
    expect(partyCountry(undefined)).toBeNull()
    expect(partyCountry(null)).toBeNull()
  })

  it('keeps a value nothing maps as written, trimmed', () => {
    expect(partyCountry(' Argentina ')).toBe('Argentina')
  })
})

describe('inferTypeFromParty: the country decides after the VAT number', () => {
  const party = (countryCode: string | undefined, number?: string): PartyDto => ({
    name: 'Motpart',
    identifications: number ? [{ schemeId: 'SE:ORGNR', id: number }] : [],
    postalAddress: countryCode === undefined ? undefined : { countryCode },
  })

  it.each(['SE', 'se', 'Sverige', 'SVERIGE', 'Sweden', 'SWE'])('a Swedish country spelled %j is swedish_business', (country) => {
    expect(inferTypeFromParty(party(country))).toBe('swedish_business')
  })

  it.each(['Tyskland', 'Germany', 'DE', 'Estonia', 'Danmark', 'EL'])('an EU country spelled %j is eu_business, not non_eu', (country) => {
    expect(inferTypeFromParty(party(country))).toBe('eu_business')
  })

  it.each(['Norge', 'Norway', 'NO', 'USA', 'GB'])('a country outside the EU spelled %j is non_eu_business', (country) => {
    expect(inferTypeFromParty(party(country))).toBe('non_eu_business')
  })

  it('still reads a country nothing maps as foreign', () => {
    expect(inferTypeFromParty(party('Argentina'))).toBe('non_eu_business')
  })

  it('falls through to the number when the country is empty', () => {
    expect(inferTypeFromParty(party('', '556055-1234'))).toBe('swedish_business')
    expect(inferTypeFromParty(party('  ', '12345678'))).toBe('non_eu_business')
    expect(inferTypeFromParty(party(undefined))).toBe('swedish_business')
  })

  it('lets the VAT number win over the country, as before', () => {
    expect(inferTypeFromParty(party('Sverige'), 'DE123456789')).toBe('eu_business')
    expect(inferTypeFromParty(party('Tyskland'), 'SE556055123401')).toBe('swedish_business')
  })
})

/**
 * Each provider's own payload, through its own mapper, then the migration
 * mapper: what the importer actually runs.
 */
describe('a Swedish party from every provider is typed swedish_business with country SE', () => {
  const customerCases: [string, () => ReturnType<typeof mapFortnoxToCustomer>][] = [
    ['Fortnox (Country by name)', () => mapFortnoxToCustomer({ CustomerNumber: '1', Name: 'Kund AB', Type: 'COMPANY', OrganisationNumber: '556055-1234', Country: 'Sverige' })],
    ['Fortnox without an org number', () => mapFortnoxToCustomer({ CustomerNumber: '2', Name: 'Kund', Type: 'COMPANY', Country: 'Sverige' })],
    ['Briox (English name)', () => mapBrioxToCustomer({ id: 1, name: 'Kund AB', type: 'company', org_number: '556055-1234', country: 'Sweden' })],
    ['Björn Lundén (Swedish name)', () => mapBLToCustomer({ id: '1', name: 'Kund AB', organisationNumber: '556055-1234', country: 'Sverige' })],
    ['Bokio (code)', () => mapBokioToCustomer({ id: 'c1', name: 'Kund AB', type: 'company', orgNumber: '556055-1234', address: { country: 'SE' } })],
    ['Bokio (name)', () => mapBokioToCustomer({ id: 'c2', name: 'Kund AB', type: 'company', address: { country: 'Sverige' } })],
    // CustomerApi names it InvoiceCountryCode; SupplierApi names it CountryCode.
    ['Visma (code)', () => mapVismaToCustomer({ Id: 'v1', CustomerNumber: '1', Name: 'Kund AB', CorporateIdentityNumber: '556055-1234', InvoiceCountryCode: 'SE' })],
    ['WINT (code)', () => mapWintToCustomer({ Id: 1, Name: 'Kund AB', Type: 'Company', OrgNumber: '556055-1234', BillingAddress: { CountryCode: 'SE' } })],
  ]

  it.each(customerCases)('customer: %s', (_label, dto) => {
    const row = mapCustomer(dto(), 'u', 'c')
    expect(row.customer_type).toBe('swedish_business')
    expect(row.country).toBe('SE')
  })

  const supplierCases: [string, () => ReturnType<typeof mapFortnoxToSupplier>][] = [
    ['Fortnox (Country by name)', () => mapFortnoxToSupplier({ SupplierNumber: '1', Name: 'Leverantör AB', OrganisationNumber: '556055-1234', Country: 'Sverige' })],
    ['Briox (English name)', () => mapBrioxToSupplier({ id: 1, name: 'Leverantör AB', country: 'Sweden' })],
    ['Björn Lundén (code)', () => mapBLToSupplier({ id: '1', name: 'Leverantör AB', organisationId: '556055-1234', countryCode: 'SE' })],
    ['Bokio (name)', () => mapBokioToSupplier({ id: 's1', name: 'Leverantör AB', address: { country: 'Sverige' } })],
    ['Visma (code)', () => mapVismaToSupplier({ Id: 'v1', SupplierNumber: '1', Name: 'Leverantör AB', CountryCode: 'SE' })],
  ]

  it.each(supplierCases)('supplier: %s', (_label, dto) => {
    const row = mapSupplier(dto(), 'u', 'c')
    expect(row.supplier_type).toBe('swedish_business')
    expect(row.country).toBe('SE')
  })

  it('an invoice customer stub: Fortnox writes the country on the invoice by name', () => {
    const invoice = mapFortnoxToSalesInvoice({
      DocumentNumber: '1001',
      CustomerName: 'Kund AB',
      Country: 'Sverige',
      InvoiceDate: '2026-09-01',
      Currency: 'SEK',
      Total: 1250,
    })
    expect(invoiceStubCustomerType(invoice.customer)).toBe('swedish_business')
    expect(inferTypeFromParty(invoice.customer)).toBe('swedish_business')
    expect(partyCountry(invoice.customer.postalAddress?.countryCode)).toBe('SE')
  })

  it('a foreign party keeps its foreign type', () => {
    expect(mapCustomer(mapFortnoxToCustomer({ CustomerNumber: '3', Name: 'Kunde GmbH', Type: 'COMPANY', Country: 'Tyskland' }), 'u', 'c'))
      .toMatchObject({ customer_type: 'eu_business', country: 'DE' })
    expect(mapSupplier(mapFortnoxToSupplier({ SupplierNumber: '2', Name: 'Leverandør AS', Country: 'Norge' }), 'u', 'c'))
      .toMatchObject({ supplier_type: 'non_eu_business', country: 'NO' })
  })

  it('stores no country for an empty one', () => {
    const row = mapCustomer(mapBokioToCustomer({ id: 'c3', name: 'Kund AB', type: 'company', orgNumber: '556055-1234', address: { country: '' } }), 'u', 'c')
    expect(row.country).toBeNull()
    expect(row.customer_type).toBe('swedish_business')
  })
})

describe('a Visma customer names its country InvoiceCountryCode (crm#1436)', () => {
  it('is typed by it', () => {
    expect(mapCustomer(mapVismaToCustomer({ Id: 'v2', CustomerNumber: '2', Name: 'Kunde', InvoiceCountryCode: 'DE' }), 'u', 'c'))
      .toMatchObject({ customer_type: 'eu_business', country: 'DE' })
  })
})
