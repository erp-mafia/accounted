import { describe, it, expect } from 'vitest'
import { planRegistryQueries } from '../registry-search'

describe('planRegistryQueries', () => {
  it('asks for the Swedish legal person before the bank memo head', () => {
    const plan = planRegistryQueries({
      legalName: null,
      displayName: 'TIC identity',
      voucherTexts: ['TIC identity     BG 0000005786439 Bg-bet. via internet · Faktura 20250746, The Intelligence Company AB (publ). TIC Identity-abonnemang.'],
    })
    expect(plan.queries).toEqual(['The Intelligence Company', 'TIC identity'])
    expect(plan.foreign).toBeNull()
  })

  it('plans no SCB query for a foreign company and says which one it read', () => {
    const plan = planRegistryQueries({
      legalName: null,
      displayName: 'Framer B.V.',
      voucherTexts: ['Utlägg Framer · Framer B.V. (NL), webbdesignverktyg.'],
    })
    expect(plan.queries).toEqual([])
    expect(plan.foreign).toEqual({ name: 'Framer B.V.', legalForm: 'B.V.', country: 'NL' })
  })

  it('reads the country anchor when the head is a card memo', () => {
    const plan = planRegistryQueries({
      legalName: null,
      displayName: 'Claude Maj H',
      voucherTexts: ['Claude Maj H Överföring via internet · Anthropic Ireland, faktura 22,5 EUR inkl 4,5 EUR VAT-Sweden 25% via OSS.'],
    })
    expect(plan.queries).toEqual([])
    expect(plan.foreign).toEqual({ name: 'Anthropic Ireland', country: 'IE' })
  })

  it('uses the plain name when nothing points abroad, and caps at three queries', () => {
    const plan = planRegistryQueries({ legalName: 'Adobe Systems Software', displayName: 'ADOBE SYSTEMS', voucherTexts: [] })
    expect(plan.queries).toEqual(['Adobe Systems Software', 'ADOBE SYSTEMS'])
    expect(plan.foreign).toBeNull()
    const many = planRegistryQueries({
      legalName: null,
      displayName: 'Acme',
      voucherTexts: ['Alfa AB · x', 'Beta AB · y', 'Gamma AB · z', 'Delta AB · w'],
    })
    expect(many.queries).toHaveLength(3)
  })
})
