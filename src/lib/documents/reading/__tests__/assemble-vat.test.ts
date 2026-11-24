import { describe, expect, it } from 'vitest'
import { countryFromVatIdentifier, projectExtraction } from '../assemble'

describe('the seller VAT identifier and country off an extraction (crm#1411)', () => {
  it('neither shows a VAT-code label as the seller VAT number nor takes the country from it', () => {
    const values = projectExtraction({ supplier: { name: 'Synthetic Hosting Inc.', vatNumber: 'SESL000D' } })

    expect(values.seller_name).toBe('Synthetic Hosting Inc.')
    expect(values).not.toHaveProperty('seller_vat_identifier')
    expect(values).not.toHaveProperty('seller_country_code')
    expect(countryFromVatIdentifier('SESL000D')).toBeUndefined()
  })

  it('keeps a real VAT number and its country', () => {
    const values = projectExtraction({ supplier: { vatNumber: 'SE556677889901' } })

    expect(values.seller_vat_identifier).toBe('SE556677889901')
    expect(values.seller_country_code).toBe('SE')
    expect(countryFromVatIdentifier('EL094014201')).toBe('GR')
    expect(countryFromVatIdentifier('GB123456789')).toBe('GB')
  })
})

describe('the seller country of a Swedish VAT number beside an address abroad', () => {
  it('shows the address\'s country, not Sweden', () => {
    const values = projectExtraction({
      supplier: { vatNumber: 'SE502012345601', address: '1 Example Road\nSingapore 123456\nSingapore' },
    })

    expect(values.seller_vat_identifier).toBe('SE502012345601')
    expect(values.seller_country_code).toBe('SG')
  })

  it('keeps Sweden for a Swedish VAT number with a Swedish address', () => {
    const values = projectExtraction({ supplier: { vatNumber: 'SE556677889901', address: 'Storgatan 1, 111 22 Stockholm' } })

    expect(values.seller_country_code).toBe('SE')
  })
})
