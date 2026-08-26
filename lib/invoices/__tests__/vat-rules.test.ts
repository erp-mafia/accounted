import { describe, it, expect } from 'vitest'
import {
  getAvailableVatRates,
  getArticleVatRateAdoptionSet,
  getPermittedVatRates,
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

  it('does not gate on seller VAT-registration status', () => {
    // ML 16 kap. 23 § (faktureringsmoms): the picker offers the full
    // customer-type-based rate set regardless of whether the seller is
    // momsregistrerad. The invoice form surfaces a warning at submit time
    // when a non-registered seller picks a non-zero rate.
    const rates = getAvailableVatRates('swedish_business')
    expect(rates).toHaveLength(4)
    expect(rates.map((r) => r.rate)).toEqual([25, 12, 6, 0])
  })
})

// ============================================================
// getPermittedVatRates
//
// The DEFAULT for a foreign business customer is 0% (huvudregeln,
// ML 6 kap. 34 §: B2B services taxed where the buyer is established).
// The PERMITTED set is wider: the ML 6 kap. exceptions taxed where the supply
// is performed carry Swedish VAT even to a foreign business customer.
// ============================================================

describe('getPermittedVatRates', () => {
  it('matches the offered set for domestic customer types', () => {
    for (const type of ['individual', 'swedish_business'] as const) {
      expect(getPermittedVatRates(type)).toEqual(getAvailableVatRates(type))
    }
    expect(getPermittedVatRates('eu_business', false)).toEqual(
      getAvailableVatRates('eu_business', false),
    )
  })

  it('permits Swedish rates for a validated EU business (taxed where performed)', () => {
    // Restaurang/catering and hotel are taxed where performed (12%), admission
    // to cultural/sports events where the event is held (6%), fastighets-
    // tjänster and korttidsuthyrning of vehicles at 25%. All lawful on an
    // invoice to a German company, so all three must be permitted.
    const rates = getPermittedVatRates('eu_business', true)
    expect(rates.map((r) => r.rate)).toEqual([0, 25, 12, 6])
  })

  it('permits Swedish rates for a non-EU business (taxed where performed)', () => {
    const rates = getPermittedVatRates('non_eu_business')
    expect(rates.map((r) => r.rate)).toEqual([0, 25, 12, 6])
  })

  it('keeps the 0% reverse-charge / export option FIRST so the default stays 0%', () => {
    // Consumers that treat element 0 as the default must keep defaulting to
    // 0%: widening the permitted set must never start booking 25% by itself.
    expect(getPermittedVatRates('eu_business', true)[0]).toEqual({
      rate: 0,
      label: '0% (omvänd skattskyldighet)',
      treatment: 'reverse_charge',
    })
    expect(getPermittedVatRates('non_eu_business')[0]).toEqual({
      rate: 0,
      label: '0% (export)',
      treatment: 'export',
    })
  })

  it('does NOT widen the picker default: getAvailableVatRates stays locked to 0%', () => {
    // The picker default and the validation gate are deliberately separate.
    expect(getAvailableVatRates('eu_business', true)).toHaveLength(1)
    expect(getAvailableVatRates('non_eu_business')).toHaveLength(1)
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

  it('does not gate on seller VAT-registration status', () => {
    // ML 16 kap. 23 § (faktureringsmoms): a non-registered seller who states
    // VAT still owes it. The rule output reflects the customer-type rate so
    // the booking is consistent with what the buyer sees on the invoice.
    const rules = getVatRules('swedish_business')
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

// ============================================================
// getArticleVatRateAdoptionSet
// ============================================================

describe('getArticleVatRateAdoptionSet', () => {
  it('adopts nothing for a VAT-validated EU business (single locked 0% reverse charge)', () => {
    expect(getArticleVatRateAdoptionSet('eu_business', true).size).toBe(0)
  })

  it('adopts nothing for a non-EU business (single locked 0% export)', () => {
    expect(getArticleVatRateAdoptionSet('non_eu_business', false).size).toBe(0)
  })

  it('adopts the full domestic set for a Swedish business', () => {
    const set = getArticleVatRateAdoptionSet('swedish_business', false)
    expect([...set].sort((a, b) => a - b)).toEqual([0, 6, 12, 25])
  })

  it('adopts the full domestic set for an EU business WITHOUT validated VAT', () => {
    const set = getArticleVatRateAdoptionSet('eu_business', false)
    expect(set.has(25)).toBe(true)
  })

  it('is always a subset of the permitted set (adoption can never stage an unlawful rate)', () => {
    const combos: Array<['individual' | 'swedish_business' | 'eu_business' | 'non_eu_business', boolean]> = [
      ['individual', false],
      ['swedish_business', false],
      ['eu_business', false],
      ['eu_business', true],
      ['non_eu_business', false],
    ]
    for (const [type, validated] of combos) {
      const permitted = new Set(getPermittedVatRates(type, validated).map((r) => r.rate))
      for (const rate of getArticleVatRateAdoptionSet(type, validated)) {
        expect(permitted.has(rate)).toBe(true)
      }
    }
  })
})
