/**
 * The customer's country gates reverse charge (#2025). An eu_business row
 * with a validated German VAT number but country SE used to get 0% here,
 * and the periodisk sammanställning was the first thing to object, after
 * the invoice had been sent and booked on 3308.
 */
import { describe, it, expect } from 'vitest'
import {
  getArticleVatRateAdoptionSet,
  getAvailableVatRates,
  getPermittedVatRates,
  getVatRules,
  isReverseChargeCustomer,
} from '../vat-rules'

describe('reverse charge requires an EU country other than Sweden', () => {
  it('grants reverse charge to a validated EU business in another EU country', () => {
    expect(isReverseChargeCustomer('eu_business', true, 'DE')).toBe(true)
    expect(getVatRules('eu_business', true, 'DE')).toMatchObject({ treatment: 'reverse_charge', rate: 0, momsRuta: '39' })
    expect(getAvailableVatRates('eu_business', true, 'DE').map((r) => r.treatment)).toEqual(['reverse_charge'])
    expect(getPermittedVatRates('eu_business', true, 'DE')[0].treatment).toBe('reverse_charge')
    expect(getArticleVatRateAdoptionSet('eu_business', true, 'DE').size).toBe(0)
  })

  it('refuses reverse charge when the country is Sweden (#2025)', () => {
    expect(isReverseChargeCustomer('eu_business', true, 'SE')).toBe(false)
    expect(getVatRules('eu_business', true, 'SE')).toMatchObject({ treatment: 'standard_25', rate: 25, momsRuta: '05' })
    expect(getAvailableVatRates('eu_business', true, 'SE').map((r) => r.rate)).toEqual([25, 12, 6, 0])
    // The permitted set is the domestic set, not "0% first plus the Swedish rates".
    expect(getPermittedVatRates('eu_business', true, 'SE').map((r) => r.treatment)).toEqual([
      'standard_25',
      'reduced_12',
      'reduced_6',
      'exempt',
    ])
    expect(getArticleVatRateAdoptionSet('eu_business', true, 'SE')).toEqual(new Set([25, 12, 6, 0]))
  })

  it('keeps reverse charge for a validated number with a non-EU address', () => {
    // The VIES-validated number is the stronger evidence of an EU
    // registration: a Swiss company registered in Germany, Monaco,
    // Northern Ireland. Only Sweden refuses.
    expect(getVatRules('eu_business', true, 'CH').treatment).toBe('reverse_charge')
    expect(getVatRules('eu_business', true, 'MC').treatment).toBe('reverse_charge')
    expect(getVatRules('eu_business', true, 'GB').treatment).toBe('reverse_charge')
  })

  it('reads a legacy country name the same way as its code', () => {
    expect(getVatRules('eu_business', true, 'Sweden').treatment).toBe('standard_25')
    expect(getVatRules('eu_business', true, 'Germany').treatment).toBe('reverse_charge')
  })

  it('keeps the pre-2026-09 behaviour when the country is unknown', () => {
    expect(getVatRules('eu_business', true).treatment).toBe('reverse_charge')
    expect(getVatRules('eu_business', true, null).treatment).toBe('reverse_charge')
    expect(getVatRules('eu_business', true, 'Deutschland (Bayern)').treatment).toBe('reverse_charge')
  })

  it('does not touch export or domestic customers', () => {
    expect(getVatRules('non_eu_business', false, 'SE').treatment).toBe('export')
    expect(getVatRules('swedish_business', true, 'DE').treatment).toBe('standard_25')
    expect(getVatRules('eu_business', false, 'DE').treatment).toBe('standard_25')
  })
})
