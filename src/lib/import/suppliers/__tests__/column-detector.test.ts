import { describe, it, expect } from 'vitest'
import { detectSupplierColumns } from '../column-detector'

describe('detectSupplierColumns', () => {
  it('detects Swedish supplier register headers', () => {
    const headers = ['Namn', 'Orgnr', 'Bankgiro', 'Plusgiro', 'IBAN', 'BIC', 'E-post']
    const result = detectSupplierColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.bankgiro_col).toBe(2)
    expect(result.plusgiro_col).toBe(3)
    expect(result.iban_col).toBe(4)
    expect(result.bic_col).toBe(5)
    expect(result.email_col).toBe(6)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('handles supplier-specific keyword "Leverantör"', () => {
    const headers = ['Leverantör', 'Orgnummer', 'Bankgiro']
    const result = detectSupplierColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.org_number_col).toBe(1)
    expect(result.bankgiro_col).toBe(2)
  })

  it('does not confuse plusgiro with bankgiro', () => {
    const headers = ['Namn', 'Plusgiro', 'Bankgiro']
    const result = detectSupplierColumns(headers)
    expect(result.plusgiro_col).toBe(1)
    expect(result.bankgiro_col).toBe(2)
  })

  it('returns confidence 0 with no name column', () => {
    const headers = ['ColA', 'ColB']
    const result = detectSupplierColumns(headers)
    expect(result.confidence).toBe(0)
  })
  // #2548: Visma Administration / Spiris exports lead with a record-number
  // column, which first-substring-wins read as the name ("supplier" is inside
  // "Supplier number") while "Corporate identity number" was lost to 'co'.
  it('maps an English Visma/Spiris supplier export', () => {
    const headers = [
      'Supplier number', 'Supplier name', 'Corporate identity number',
      'VAT number', 'Address', 'Postal code', 'City', 'E-mail', 'Phone',
      'Bankgiro',
    ]
    const result = detectSupplierColumns(headers)
    expect(result.name_col).toBe(1)
    expect(result.org_number_col).toBe(2)
    expect(result.vat_number_col).toBe(3)
    expect(result.address_line1_col).toBe(4)
    expect(result.address_line2_col).toBeNull()
    expect(result.postal_code_col).toBe(5)
    expect(result.city_col).toBe(6)
    expect(result.email_col).toBe(7)
    expect(result.phone_col).toBe(8)
    expect(result.bankgiro_col).toBe(9)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('maps a Swedish Visma supplier export', () => {
    const headers = [
      'Leverantörsnummer', 'Leverantörsnamn', 'Organisationsnummer',
      'Momsregistreringsnummer', 'Adress 1', 'Postnummer', 'Ort', 'E-post',
      'Telefon', 'Bankgiro',
    ]
    const result = detectSupplierColumns(headers)
    expect(result.name_col).toBe(1)
    expect(result.org_number_col).toBe(2)
    expect(result.vat_number_col).toBe(3)
    expect(result.address_line1_col).toBe(4)
    expect(result.address_line2_col).toBeNull()
    expect(result.postal_code_col).toBe(5)
    expect(result.city_col).toBe(6)
    expect(result.email_col).toBe(7)
    expect(result.phone_col).toBe(8)
    expect(result.bankgiro_col).toBe(9)
    expect(result.confidence).toBeGreaterThanOrEqual(0.8)
  })

  it('does not read "Country" as address line 2', () => {
    const headers = ['Namn', 'Adress', 'Country', 'Postnr']
    const result = detectSupplierColumns(headers)
    expect(result.address_line2_col).toBeNull()
    expect(result.country_col).toBe(2)
  })

  it('caps confidence below the mapping gate when the name is a substring guess', () => {
    const headers = [
      'Leverantörsuppgifter', 'Orgnr', 'E-post', 'Telefon', 'Adress', 'Postnr', 'Ort',
    ]
    const result = detectSupplierColumns(headers)
    expect(result.name_col).toBe(0)
    expect(result.confidence).toBeLessThan(0.8)
  })

  it('leaves name_col unmatched instead of claiming column 0', () => {
    const result = detectSupplierColumns(['Leverantörsnummer', 'Bankgiro'])
    expect(result.name_col).toBe(-1)
    expect(result.confidence).toBe(0)
  })
  it('keeps "Address line 2" as line 2 when there is no line 1', () => {
    const result = detectSupplierColumns(['Namn', 'Address line 2', 'Postnr'])
    expect(result.address_line2_col).toBe(1)
    expect(result.address_line1_col).toBeNull()
  })
})
