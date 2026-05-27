import { describe, it, expect } from 'vitest'
import {
  getAvailableVatRates,
  getVatTreatmentForRate,
  getVatRules,
  calculateVat,
  calculateTotal,
  formatVatRate,
  getVatTreatmentLabel,
  getVatSummaryFromItems,
  getMomsRutaDescription,
} from '../vat-rules'

// ============================================================
// getAvailableVatRates
// ============================================================

describe('getAvailableVatRates', () => {
  it('returns all 4 Swedish rates for individual customer', () => {
    const rates = getAvailableVatRates('individual')
    expect(rates).toHaveLength(4)
    expect(rates.map((r) => r.rate)).toEqual([25, 12, 6, 0])
    expect(rates.map((r) => r.treatment)).toEqual([
      'standard_25',
      'reduced_12',
      'reduced_6',
      'exempt',
    ])
  })

  it('returns all 4 Swedish rates for swedish_business', () => {
    const rates = getAvailableVatRates('swedish_business')
    expect(rates).toHaveLength(4)
    expect(rates.map((r) => r.rate)).toEqual([25, 12, 6, 0])
  })

  it('returns only reverse_charge 0% for eu_business with validated VAT', () => {
    const rates = getAvailableVatRates('eu_business', true)
    expect(rates).toHaveLength(1)
    expect(rates[0]).toEqual({
      rate: 0,
      label: '0% (omvänd skattskyldighet)',
      treatment: 'reverse_charge',
    })
  })

  it('returns all 4 rates for eu_business WITHOUT validated VAT', () => {
    // ML compliance: must charge Swedish VAT when VAT number not validated
    const rates = getAvailableVatRates('eu_business', false)
    expect(rates).toHaveLength(4)
    expect(rates.map((r) => r.rate)).toEqual([25, 12, 6, 0])
  })

  it('returns only export 0% for non_eu_business', () => {
    const rates = getAvailableVatRates('non_eu_business')
    expect(rates).toHaveLength(1)
    expect(rates[0]).toEqual({
      rate: 0,
      label: '0% (export)',
      treatment: 'export',
    })
  })

  it('defaults vatNumberValidated to false', () => {
    // eu_business without explicit vatNumberValidated should get all rates
    const rates = getAvailableVatRates('eu_business')
    expect(rates).toHaveLength(4)
  })

  it('collapses to 0%/exempt for non-registered sellers regardless of customer type', () => {
    // ML 1 kap. 1§ — only a skattskyldig may charge output VAT. The picker
    // must never offer non-zero rates when vat_registered=false; the API
    // route (route.ts) and preview-pdf route enforce the same gate so a
    // client bypassing the UI also gets rejected.
    for (const customerType of ['individual', 'swedish_business', 'eu_business', 'non_eu_business'] as const) {
      const rates = getAvailableVatRates(customerType, false, false)
      expect(rates).toHaveLength(1)
      expect(rates[0]).toEqual({
        rate: 0,
        label: '0% (ej momsregistrerad)',
        treatment: 'exempt',
      })
    }
  })

  it('defaults vatRegistered to true (legitimate VAT path)', () => {
    // Explicit default-arg pin so a future signature change doesn't silently
    // flip the default and strip VAT from invoices for registered sellers.
    const rates = getAvailableVatRates('swedish_business', false)
    expect(rates).toHaveLength(4)
  })
})

// ============================================================
// getVatTreatmentForRate
// ============================================================

describe('getVatTreatmentForRate', () => {
  it('maps 25 → standard_25', () => {
    expect(getVatTreatmentForRate(25)).toBe('standard_25')
  })

  it('maps 12 → reduced_12', () => {
    expect(getVatTreatmentForRate(12)).toBe('reduced_12')
  })

  it('maps 6 → reduced_6', () => {
    expect(getVatTreatmentForRate(6)).toBe('reduced_6')
  })

  it('maps 0 → exempt', () => {
    expect(getVatTreatmentForRate(0)).toBe('exempt')
  })

  it('defaults unknown rates to standard_25', () => {
    expect(getVatTreatmentForRate(15)).toBe('standard_25')
    expect(getVatTreatmentForRate(99)).toBe('standard_25')
  })
})

// ============================================================
// getVatRules
// ============================================================

describe('getVatRules', () => {
  it('returns standard_25 / rate 25 / ruta 05 for individual', () => {
    const rules = getVatRules('individual')
    expect(rules).toEqual({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '05',
    })
  })

  it('returns standard_25 / rate 25 / ruta 05 for swedish_business', () => {
    const rules = getVatRules('swedish_business')
    expect(rules).toEqual({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '05',
    })
  })

  it('returns reverse_charge / rate 0 / ruta 39 for eu_business with validated VAT', () => {
    const rules = getVatRules('eu_business', true)
    expect(rules.treatment).toBe('reverse_charge')
    expect(rules.rate).toBe(0)
    expect(rules.momsRuta).toBe('39')
    // Verify text references Article 196 of Council Directive 2006/112/EC
    expect(rules.reverseChargeText).toContain('Article 196')
    expect(rules.reverseChargeText).toContain('2006/112/EC')
  })

  it('returns standard_25 / rate 25 / ruta 05 for eu_business WITHOUT validated VAT', () => {
    const rules = getVatRules('eu_business', false)
    expect(rules).toEqual({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '05',
    })
  })

  it('returns export / rate 0 / ruta 40 for non_eu_business', () => {
    const rules = getVatRules('non_eu_business')
    expect(rules.treatment).toBe('export')
    expect(rules.rate).toBe(0)
    expect(rules.momsRuta).toBe('40')
    // Verify text references ML 10 kap
    expect(rules.reverseChargeText).toContain('ML 10 kap')
  })

  it('defaults to standard_25 for unknown customerType', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = getVatRules('unknown_type' as any)
    expect(rules).toEqual({
      treatment: 'standard_25',
      rate: 25,
      momsRuta: '05',
    })
  })

  it('short-circuits to exempt / rate 0 / empty momsRuta for non-registered sellers', () => {
    // ML 1 kap. 1§ — non-skattskyldig cannot charge output VAT. momsRuta is
    // intentionally empty so a downstream momsdeklaration generator never
    // mis-files a non-registered seller's revenue into ruta 05.
    for (const customerType of ['individual', 'swedish_business', 'eu_business', 'non_eu_business'] as const) {
      const rules = getVatRules(customerType, false, false)
      expect(rules).toEqual({
        treatment: 'exempt',
        rate: 0,
        momsRuta: '',
      })
    }
  })

  it('defaults vatRegistered to true (legitimate VAT path)', () => {
    // Explicit default-arg pin (see corresponding getAvailableVatRates test).
    const rules = getVatRules('swedish_business', false)
    expect(rules.rate).toBe(25)
    expect(rules.treatment).toBe('standard_25')
    expect(rules.momsRuta).toBe('05')
  })
})

// ============================================================
// calculateVat
// Pin: vatRate is a whole number (25, not 0.25).
// Formula: Math.round(subtotal * vatRate) / 100
// ============================================================

describe('calculateVat', () => {
  it('calculates 25% of 10000 → 2500', () => {
    expect(calculateVat(10000, 25)).toBe(2500)
  })

  it('calculates 12% of 5000 → 600', () => {
    expect(calculateVat(5000, 12)).toBe(600)
  })

  it('calculates 6% of 3000 → 180', () => {
    expect(calculateVat(3000, 6)).toBe(180)
  })

  it('calculates 0% of 10000 → 0', () => {
    expect(calculateVat(10000, 0)).toBe(0)
  })

  it('rounds correctly: 99.99 at 25% → 25', () => {
    // Math.round(99.99 * 25) / 100 = Math.round(2499.75) / 100 = 2500 / 100 = 25
    expect(calculateVat(99.99, 25)).toBe(25)
  })
})

// ============================================================
// calculateTotal
// ============================================================

describe('calculateTotal', () => {
  it('returns subtotal + VAT rounded: 10000 at 25% → 12500', () => {
    expect(calculateTotal(10000, 25)).toBe(12500)
  })

  it('handles 0% VAT: total equals subtotal', () => {
    expect(calculateTotal(5000, 0)).toBe(5000)
  })
})

// ============================================================
// formatVatRate
// ============================================================

describe('formatVatRate', () => {
  it('formats 25 as "25%"', () => {
    expect(formatVatRate(25)).toBe('25%')
  })

  it('formats 0 as "0%"', () => {
    expect(formatVatRate(0)).toBe('0%')
  })
})

// ============================================================
// getVatTreatmentLabel
// ============================================================

describe('getVatTreatmentLabel', () => {
  it('returns correct Swedish label for each treatment', () => {
    expect(getVatTreatmentLabel('standard_25')).toBe('25% moms')
    expect(getVatTreatmentLabel('reduced_12')).toBe('12% moms')
    expect(getVatTreatmentLabel('reduced_6')).toBe('6% moms')
    expect(getVatTreatmentLabel('reverse_charge')).toBe('Omvänd skattskyldighet (0%)')
    expect(getVatTreatmentLabel('export')).toBe('Export (0%)')
    expect(getVatTreatmentLabel('exempt')).toBe('Momsfritt')
  })
})

// ============================================================
// getVatSummaryFromItems
// ============================================================

describe('getVatSummaryFromItems', () => {
  it('returns single rate info when all items have same rate', () => {
    const result = getVatSummaryFromItems([{ vat_rate: 25 }, { vat_rate: 25 }])
    expect(result.isMixed).toBe(false)
    expect(result.rate).toBe(25)
    expect(result.treatment).toBe('standard_25')
    expect(result.label).toBe('25% moms')
  })

  it('returns isMixed=true when items have different rates', () => {
    const result = getVatSummaryFromItems([{ vat_rate: 25 }, { vat_rate: 12 }])
    expect(result.isMixed).toBe(true)
    expect(result.rate).toBeNull()
    expect(result.treatment).toBeNull()
    expect(result.label).toBe('Blandade momssatser')
  })

  it('treats null vat_rate as 0', () => {
    const result = getVatSummaryFromItems([{ vat_rate: null }, { vat_rate: null }])
    expect(result.isMixed).toBe(false)
    expect(result.rate).toBe(0)
    expect(result.treatment).toBe('exempt')
  })
})

// ============================================================
// getMomsRutaDescription
// ============================================================

describe('getMomsRutaDescription', () => {
  it('maps ruta 05 → "Utgående moms 25%"', () => {
    expect(getMomsRutaDescription('05')).toBe('Utgående moms 25%')
  })

  it('maps ruta 39 → "Försäljning av tjänster till annat EU-land"', () => {
    expect(getMomsRutaDescription('39')).toBe('Försäljning av tjänster till annat EU-land')
  })

  it('maps ruta 40 → "Export utanför EU"', () => {
    expect(getMomsRutaDescription('40')).toBe('Export utanför EU')
  })

  it('returns the ruta string itself for unknown rutor', () => {
    expect(getMomsRutaDescription('99')).toBe('99')
  })
})
