import { describe, it, expect } from 'vitest'
import {
  explainVatTreatment,
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
  requiresSwedishVatAcknowledgement,
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

// ============================================================
// explainVatTreatment: why an invoice gets the treatment it gets (#2749, #2558)
// ============================================================

describe('explainVatTreatment', () => {
  const euUnvalidated = {
    id: 'cust-de',
    customer_type: 'eu_business' as const,
    vat_number: 'DE123456789',
    vat_number_validated: false,
    country: 'DE',
  }

  it('names the unvalidated VAT number as the reason an EU business gets Swedish VAT', () => {
    const warnings = explainVatTreatment(euUnvalidated, [25])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED')
    expect(warnings[0].message_sv).toBe(
      'Omvänd skattskyldighet tillämpas inte: momsnumret är inte validerat. Fakturan får svensk moms tills momsnumret har kontrollerats mot VIES (ML 6 kap. 34 §).',
    )
    expect(warnings[0].message_en).toMatch(/Reverse charge is not applied: the VAT number is not validated/)
    // The remediation carries what an agent needs to re-run the VIES check.
    expect(warnings[0].remediation).toMatchObject({
      tool: 'gnubok_update_customer',
      args: { customer_id: 'cust-de', vat_number: 'DE123456789' },
    })
  })

  it('says so even when every line is 0 %: the header is still not reverse charge', () => {
    // No Swedish VAT is charged, but nothing lands in ruta 39 either.
    const warnings = explainVatTreatment(euUnvalidated, [0])
    expect(warnings.map((w) => w.code)).toEqual(['EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED'])
  })

  it('distinguishes a missing VAT number from an unvalidated one', () => {
    const warnings = explainVatTreatment({ ...euUnvalidated, vat_number: null }, [25])
    expect(warnings.map((w) => w.code)).toEqual(['EU_BUSINESS_VAT_NUMBER_MISSING'])
    expect(explainVatTreatment({ ...euUnvalidated, vat_number: '   ' }, [25])[0].code).toBe(
      'EU_BUSINESS_VAT_NUMBER_MISSING',
    )
  })

  it('names country SE as the reason when a validated EU business is established in Sweden (#2025)', () => {
    const warnings = explainVatTreatment(
      { ...euUnvalidated, vat_number_validated: true, country: 'SE' },
      [25],
    )
    expect(warnings.map((w) => w.code)).toEqual(['EU_BUSINESS_COUNTRY_IS_SE'])
    // The country check comes first: a Swedish address wins over the number.
    expect(explainVatTreatment({ ...euUnvalidated, country: 'Sverige' }, [25])[0].code).toBe(
      'EU_BUSINESS_COUNTRY_IS_SE',
    )
  })

  it('stays silent for a validated EU business on 0 % lines (the normal reverse-charge case)', () => {
    expect(explainVatTreatment({ ...euUnvalidated, vat_number_validated: true }, [0, 0])).toEqual([])
    expect(explainVatTreatment({ ...euUnvalidated, vat_number_validated: true }, [])).toEqual([])
  })

  it('warns, without blocking, about a Swedish rate to a validated EU business (#2558)', () => {
    const warnings = explainVatTreatment({ ...euUnvalidated, vat_number_validated: true }, [0, 12, 25])
    expect(warnings).toHaveLength(1)
    expect(warnings[0].code).toBe('SWEDISH_VAT_TO_REVERSE_CHARGE_CUSTOMER')
    expect(warnings[0].message_sv).toContain('Svensk moms (12 % och 25 %)')
    expect(warnings[0].message_sv).toContain('ML 6 kap.')
    expect(warnings[0].message_en).toContain('Swedish VAT (12 % and 25 %)')
  })

  it('warns about a Swedish rate to a non-EU business, silent on export 0 %', () => {
    const nonEu = { customer_type: 'non_eu_business' as const, country: 'US' }
    expect(explainVatTreatment(nonEu, [0])).toEqual([])
    const warnings = explainVatTreatment(nonEu, [12])
    expect(warnings.map((w) => w.code)).toEqual(['SWEDISH_VAT_TO_EXPORT_CUSTOMER'])
    expect(warnings[0].message_sv).toContain('Svensk moms (12 %)')
  })

  it('has nothing to say about domestic customers', () => {
    expect(explainVatTreatment({ customer_type: 'swedish_business', country: 'SE' }, [25, 12])).toEqual([])
    expect(explainVatTreatment({ customer_type: 'individual', country: 'SE' }, [25])).toEqual([])
  })

  it('never contradicts the rule: says "not applied" exactly when isReverseChargeCustomer is false', () => {
    // The explanation is only worth having if it cannot disagree with the
    // rule it explains. Sweep type x validated x country x number-present:
    // the three blocked codes appear if and only if an eu_business customer
    // does NOT get the reverse_charge treatment from getVatRules().
    const blocked = new Set([
      'EU_BUSINESS_VAT_NUMBER_MISSING',
      'EU_BUSINESS_VAT_NUMBER_NOT_VALIDATED',
      'EU_BUSINESS_COUNTRY_IS_SE',
    ])
    const types = ['individual', 'swedish_business', 'eu_business', 'non_eu_business'] as const
    for (const customer_type of types) {
      for (const vat_number_validated of [true, false]) {
        for (const country of ['DE', 'SE', null, 'Deutschland']) {
          for (const vat_number of ['DE123456789', null]) {
            const codes = explainVatTreatment({ customer_type, vat_number_validated, country, vat_number }, [25]).map((w) => w.code)
            const treatment = getVatRules(customer_type, vat_number_validated, country).treatment
            const saysBlocked = codes.some((code) => blocked.has(code))
            const isBlocked = customer_type === 'eu_business' && treatment !== 'reverse_charge'
            expect(saysBlocked, `${customer_type}/${vat_number_validated}/${country}/${vat_number}`).toBe(isBlocked)
          }
        }
      }
    }
  })

  it('treats a validated row without a vat_number as reverse-charged (narrow projections, legacy rows)', () => {
    // vat_number_validated is what the rule reads. A caller that selected
    // only the rule columns must not be told reverse charge is off.
    const validatedNoNumber = { customer_type: 'eu_business' as const, vat_number_validated: true, country: 'DE' }
    expect(explainVatTreatment(validatedNoNumber, [0])).toEqual([])
    expect(explainVatTreatment(validatedNoNumber, [12]).map((w) => w.code)).toEqual([
      'SWEDISH_VAT_TO_REVERSE_CHARGE_CUSTOMER',
    ])
  })

  it('never returns more than one warning: the failed condition, not a list of rules', () => {
    for (const rates of [[25], [0], [25, 12, 6, 0]]) {
      expect(explainVatTreatment(euUnvalidated, rates).length).toBeLessThanOrEqual(1)
      expect(explainVatTreatment({ ...euUnvalidated, vat_number_validated: true }, rates).length).toBeLessThanOrEqual(1)
    }
  })
})

describe('requiresSwedishVatAcknowledgement', () => {
  const euUnvalidated = {
    customer_type: 'eu_business' as const,
    vat_number: 'DE123456789',
    vat_number_validated: false,
    country: 'DE',
  }

  it('asks for the tick only when reverse charge is blocked AND Swedish VAT is charged', () => {
    expect(requiresSwedishVatAcknowledgement(explainVatTreatment(euUnvalidated, [25]), [25])).toBe(true)
    expect(
      requiresSwedishVatAcknowledgement(explainVatTreatment({ ...euUnvalidated, vat_number: null }, [12]), [12]),
    ).toBe(true)
    expect(
      requiresSwedishVatAcknowledgement(
        explainVatTreatment({ ...euUnvalidated, vat_number_validated: true, country: 'SE' }, [25]),
        [25],
      ),
    ).toBe(true)
  })

  it('does not ask on an all-0 % invoice: nothing is charged, the warning alone is enough', () => {
    expect(requiresSwedishVatAcknowledgement(explainVatTreatment(euUnvalidated, [0]), [0])).toBe(false)
  })

  it('does not ask for the taxed-where-performed warnings (#2558 is warn-only)', () => {
    const validated = { ...euUnvalidated, vat_number_validated: true }
    expect(requiresSwedishVatAcknowledgement(explainVatTreatment(validated, [12]), [12])).toBe(false)
    const nonEu = { customer_type: 'non_eu_business' as const, country: 'US' }
    expect(requiresSwedishVatAcknowledgement(explainVatTreatment(nonEu, [25]), [25])).toBe(false)
    expect(requiresSwedishVatAcknowledgement([], [25])).toBe(false)
  })
})
