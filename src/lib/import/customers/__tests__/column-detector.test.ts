import { describe, it, expect } from 'vitest'
import { detectCustomerColumns } from '../column-detector'

describe('detectCustomerColumns', () => {
  it('detects Swedish customer register headers', () => {
    const headers = ['Namn', 'Orgnr', 'E-post', 'Telefon', 'Adress', 'Postnr', 'Ort']
    const result = detectCustomerColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.email_col).toBe(2)
    expect(result.phone_col).toBe(3)
    expect(result.address_line1_col).toBe(4)
    expect(result.postal_code_col).toBe(5)
    expect(result.city_col).toBe(6)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('detects English headers', () => {
    const headers = ['Customer Name', 'Organization Number', 'Email', 'Phone']
    const result = detectCustomerColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.email_col).toBe(2)
    expect(result.phone_col).toBe(3)
  })

  it('handles missing optional columns', () => {
    const headers = ['Kundnamn']
    const result = detectCustomerColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.email_col).toBeNull()
    expect(result.org_number_col).toBeNull()
  })

  it('does not match the same column twice', () => {
    const headers = ['Namn', 'Adress', 'C/O']
    const result = detectCustomerColumns(headers)
    expect(result.address_line1_col).toBe(1)
    expect(result.address_line2_col).toBe(2)
  })

  it('returns low confidence when name not matched', () => {
    const headers = ['ColA', 'ColB']
    const result = detectCustomerColumns(headers)
    expect(result.confidence).toBe(0)
  })
  // #2548: Visma Administration / Spiris exports lead with a record-number
  // column, which first-substring-wins read as the name ("customer" is inside
  // "Customer number") while "Corporate identity number" was lost to 'co'.
  it('maps an English Visma/Spiris customer export', () => {
    const headers = [
      'Customer number', 'Customer name', 'Corporate identity number',
      'VAT number', 'Address', 'Postal code', 'City', 'E-mail', 'Phone',
    ]
    const result = detectCustomerColumns(headers)
    expect(result.customer_number_col).toBe(0)
    expect(result.name_col).toBe(1)
    expect(result.org_number_col).toBe(2)
    expect(result.vat_number_col).toBe(3)
    expect(result.address_line1_col).toBe(4)
    expect(result.address_line2_col).toBeNull()
    expect(result.postal_code_col).toBe(5)
    expect(result.city_col).toBe(6)
    expect(result.email_col).toBe(7)
    expect(result.phone_col).toBe(8)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('maps a Swedish Visma customer export', () => {
    const headers = [
      'Kundnummer', 'Kundnamn', 'Organisationsnummer', 'Momsregistreringsnummer',
      'Adress 1', 'Postnummer', 'Ort', 'E-post', 'Telefon',
    ]
    const result = detectCustomerColumns(headers)
    expect(result.customer_number_col).toBe(0)
    expect(result.name_col).toBe(1)
    expect(result.org_number_col).toBe(2)
    expect(result.vat_number_col).toBe(3)
    expect(result.address_line1_col).toBe(4)
    expect(result.address_line2_col).toBeNull()
    expect(result.postal_code_col).toBe(5)
    expect(result.city_col).toBe(6)
    expect(result.email_col).toBe(7)
    expect(result.phone_col).toBe(8)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('does not read "Country" as address line 2', () => {
    const headers = ['Namn', 'Adress', 'Country', 'Postnr']
    const result = detectCustomerColumns(headers)
    expect(result.address_line2_col).toBeNull()
    expect(result.country_col).toBe(2)
  })

  it('does not read the Swedish word "Privat" as a VAT number', () => {
    const headers = ['Kundnamn', 'Privat', 'Orgnr']
    const result = detectCustomerColumns(headers)
    expect(result.vat_number_col).toBeNull()
    expect(result.org_number_col).toBe(2)
  })

  it('caps confidence below the mapping gate when the name is a substring guess', () => {
    const headers = [
      'Kundregister', 'Orgnr', 'E-post', 'Telefon', 'Adress', 'Postnr', 'Ort',
    ]
    const result = detectCustomerColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.confidence).toBeLessThan(0.8)
  })

  it('leaves name_col unmatched instead of claiming column 0', () => {
    const result = detectCustomerColumns(['Kundnummer', 'Postnr'])
    expect(result.name_col).toBe(-1)
    expect(result.confidence).toBe(0)
  })
  it('keeps "Adress 2" as line 2 when there is no line 1', () => {
    const result = detectCustomerColumns(['Namn', 'Adress 2', 'Postnr'])
    expect(result.address_line2_col).toBe(1)
    expect(result.address_line1_col).toBeNull()
  })

  it('detects a short-form customer number header', () => {
    const result = detectCustomerColumns(['Kundnr', 'Namn', 'Orgnr'])
    expect(result.customer_number_col).toBe(0)
    expect(result.name_col).toBe(1)
    expect(result.org_number_col).toBe(2)
  })

  // PH 204: the Spiris (formerly Visma eEkonomi) customer register export.
  // "InvoicePostalCode" used to win the e-mail column, so every row failed the
  // e-mail check, and the org, VAT, customer and postal numbers were dropped.
  it('maps the Spiris customer register export', () => {
    const headers = [
      'IsActive', 'CustomerNumber', 'Namn', 'IsPrivatePerson', 'CorporateIdentityNumber',
      'Postadress 1', 'Postadress 2', 'InvoicePostalCode', 'InvoiceCity', 'InvoiceCountryCode',
      'SalesDocumentLanguage', 'EdiGlnNumber', 'VatNumber', 'Telephone', 'MobilePhone',
      'EmailAddress', 'CcEmailAddresses', 'WwwAddress', 'Note', 'ForceBookkeepVat',
      'ReverseChargeOnConstructionServices', 'ContactPersonName', 'ContactPersonEmail',
      'ContactPersonPhone', 'ContactPersonMobile', 'TermOfDeliveryCode', 'DeliveryMethodCode',
      'DeliveryCustomerName', 'DeliveryAddress1', 'DeliveryAddress2', 'DeliveryPostalCode',
      'DeliveryCity', 'DeliveryCountryCode', 'TermsofPaymentCode', 'CurrencyCode',
      'PayToAccount', 'DiscountPercentage', 'CustomerLabels',
    ]
    const result = detectCustomerColumns(headers)
    const at = (col: number | null) => (col === null ? null : headers[col])
    expect(at(result.name_col)).toBe('Namn')
    expect(at(result.customer_number_col)).toBe('CustomerNumber')
    expect(at(result.org_number_col)).toBe('CorporateIdentityNumber')
    expect(at(result.customer_type_col)).toBe('IsPrivatePerson')
    expect(at(result.email_col)).toBe('EmailAddress')
    expect(at(result.phone_col)).toBe('Telephone')
    expect(at(result.address_line1_col)).toBe('Postadress 1')
    expect(at(result.address_line2_col)).toBe('Postadress 2')
    expect(at(result.postal_code_col)).toBe('InvoicePostalCode')
    expect(at(result.city_col)).toBe('InvoiceCity')
    expect(at(result.country_col)).toBe('InvoiceCountryCode')
    expect(at(result.vat_number_col)).toBe('VatNumber')
    expect(at(result.notes_col)).toBe('Note')
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('never fills the invoice address from a delivery or web address column', () => {
    const headers = ['Namn', 'WwwAddress', 'DeliveryAddress1', 'Leveransort', 'Fakturaadress', 'Ort']
    const result = detectCustomerColumns(headers)
    expect(result.address_line1_col).toBe(4)
    expect(result.city_col).toBe(5)
  })

  it('does not take another number column as the customer number', () => {
    const headers = ['Namn', 'Organisationsnummer', 'Telefonnummer', 'Postnummer', 'Momsnr']
    const result = detectCustomerColumns(headers)
    expect(result.customer_number_col).toBeNull()
    expect(result.org_number_col).toBe(1)
    expect(result.phone_col).toBe(2)
    expect(result.postal_code_col).toBe(3)
    expect(result.vat_number_col).toBe(4)
  })
})
