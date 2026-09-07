import { describe, it, expect } from 'vitest'
import {
  DOMESTIC_CONSTRUCTION_REVERSE_CHARGE_NOTICE,
  getArticleVatRateAdoptionSet,
  getAvailableVatRates,
  getPermittedVatRates,
  getVatRules,
  isDomesticConstructionReverseCharge,
} from '../vat-rules'
import type { CustomerType } from '@/types'

/**
 * Domestic reverse charge for construction services (ML 16 kap. 13 §).
 *
 * The seller issues the invoice without VAT, the buyer accounts for it. The
 * seller reports the sale in ruta 41, NOT ruta 39: ruta 39 is the EU services
 * box (huvudregeln) and a domestic sale never belongs there.
 */
describe('isDomesticConstructionReverseCharge', () => {
  it('applies to a Swedish business the seller has flagged', () => {
    expect(isDomesticConstructionReverseCharge('swedish_business', true)).toBe(true)
  })

  it('does not apply without the flag', () => {
    expect(isDomesticConstructionReverseCharge('swedish_business', false)).toBe(false)
    expect(isDomesticConstructionReverseCharge('swedish_business')).toBe(false)
  })

  it('never applies to a buyer who cannot be liable under 16 kap. 13 §', () => {
    const others: CustomerType[] = ['individual', 'eu_business', 'non_eu_business']
    for (const type of others) {
      expect(isDomesticConstructionReverseCharge(type, true)).toBe(false)
    }
  })
})

describe('getVatRules with construction reverse charge', () => {
  it('zero-rates the sale into ruta 41 with the statutory notation', () => {
    const rules = getVatRules('swedish_business', false, 'SE', true)
    expect(rules).toEqual({
      treatment: 'reverse_charge_domestic',
      rate: 0,
      momsRuta: '41',
      reverseChargeText: DOMESTIC_CONSTRUCTION_REVERSE_CHARGE_NOTICE,
    })
  })

  it('states the reverse charge on the invoice (ML 17 kap. 24 §)', () => {
    expect(DOMESTIC_CONSTRUCTION_REVERSE_CHARGE_NOTICE).toContain('Omvänd betalningsskyldighet')
  })

  it('is ruta 41 and not the EU services box 39', () => {
    expect(getVatRules('swedish_business', false, 'SE', true).momsRuta).toBe('41')
    expect(getVatRules('eu_business', true, 'DE').momsRuta).toBe('39')
  })

  it('leaves an unflagged Swedish business on 25% in ruta 05', () => {
    expect(getVatRules('swedish_business', false, 'SE', false)).toEqual({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '05',
    })
  })

  it('ignores the flag for a private person', () => {
    expect(getVatRules('individual', false, 'SE', true).treatment).toBe('standard_25')
  })

  it('ignores the flag for an EU business, which keeps the EU rule', () => {
    const rules = getVatRules('eu_business', true, 'DE', true)
    expect(rules.treatment).toBe('reverse_charge')
    expect(rules.momsRuta).toBe('39')
  })
})

describe('rate sets for a construction reverse charge customer', () => {
  it('offers a single locked 0% by default', () => {
    const rates = getAvailableVatRates('swedish_business', false, 'SE', true)
    expect(rates).toEqual([
      { rate: 0, label: '0% (omvänd betalningsskyldighet)', treatment: 'reverse_charge_domestic' },
    ])
  })

  it('still permits Swedish rates: 16 kap. 13 § covers construction services, not every supply', () => {
    // Selling material off the shelf or hiring out a machine without an
    // operator to the same byggföretag carries ordinary 25%.
    const permitted = getPermittedVatRates('swedish_business', false, 'SE', true)
    expect(permitted[0].rate).toBe(0)
    expect(permitted.map((r) => r.rate).sort((a, b) => a - b)).toEqual([0, 6, 12, 25])
  })

  it('does not adopt an article rate while the picker is locked to 0%', () => {
    expect(getArticleVatRateAdoptionSet('swedish_business', false, 'SE', true).size).toBe(0)
  })

  it('adoption stays a subset of the permitted set', () => {
    const permitted = new Set(getPermittedVatRates('swedish_business', false, 'SE', true).map((r) => r.rate))
    for (const rate of getArticleVatRateAdoptionSet('swedish_business', false, 'SE', true)) {
      expect(permitted.has(rate)).toBe(true)
    }
  })
})
