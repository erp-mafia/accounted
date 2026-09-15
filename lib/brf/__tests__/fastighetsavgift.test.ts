import { describe, expect, it } from 'vitest'
import {
  computeFastighetsavgift,
  FASTIGHETSAVGIFT_CAP_PER_LAGENHET,
  nybyggnadReduction,
} from '../fastighetsavgift'

describe('computeFastighetsavgift (lag 2007:1398, lag 1984:1052)', () => {
  it('charges the per-lägenhet takbelopp when it is below 0,3 % of the taxeringsvärde', () => {
    const c = computeFastighetsavgift({
      incomeYear: 2026,
      antalBostadslagenheter: 40,
      taxeringsvardeBostader: 120_000_000,
      taxeringsvardeLokaler: 30_000_000,
      vardear: 1998,
    })
    expect(c.bostader.capPerLagenhet).toBe(1_784)
    expect(c.bostader.capTotal).toBe(71_360)
    expect(c.bostader.percentCap).toBe(360_000)
    expect(c.bostader.amount).toBe(71_360)
    expect(c.bostader.reduction).toBe('none')
    expect(c.bostader.ink2Field).toBe('1.9 hel avgift')
    expect(c.lokaler.amount).toBe(300_000)
    expect(c.lokaler.ink2Field).toBe('1.11')
    expect(c.total).toBe(371_360)
    expect(c.bookingTemplateId).toBe('brf_fastighetsavgift')
    expect(c.warnings).toEqual([])
  })

  it('caps at 0,3 % of the bostadsdel taxeringsvärde for a low-value property', () => {
    const c = computeFastighetsavgift({
      incomeYear: 2025,
      antalBostadslagenheter: 40,
      taxeringsvardeBostader: 10_000_000,
      taxeringsvardeLokaler: 0,
      vardear: 1960,
    })
    expect(c.bostader.capTotal).toBe(40 * 1_724)
    expect(c.bostader.percentCap).toBe(30_000)
    expect(c.bostader.amount).toBe(30_000)
    expect(c.lokaler.amount).toBe(0)
    expect(c.total).toBe(30_000)
  })

  it('uses the published takbelopp for 2024, 2025 and 2026', () => {
    expect(FASTIGHETSAVGIFT_CAP_PER_LAGENHET).toEqual({ 2024: 1_630, 2025: 1_724, 2026: 1_784 })
  })

  it('exempts a building with värdeår 2012 or later for 15 years and halves the older rule', () => {
    expect(nybyggnadReduction(2026, 2020)).toBe('full')
    expect(nybyggnadReduction(2035, 2020)).toBe('full')
    expect(nybyggnadReduction(2036, 2020)).toBe('none')
    expect(nybyggnadReduction(2020, 2020)).toBe('none') // the värdeår itself
    expect(nybyggnadReduction(2012, 2010)).toBe('full') // years 1-5
    expect(nybyggnadReduction(2015, 2010)).toBe('full')
    expect(nybyggnadReduction(2016, 2010)).toBe('half') // years 6-10
    expect(nybyggnadReduction(2020, 2010)).toBe('half')
    expect(nybyggnadReduction(2021, 2010)).toBe('none')
    expect(nybyggnadReduction(2026, null)).toBe('none')

    const half = computeFastighetsavgift({
      incomeYear: 2018,
      antalBostadslagenheter: 10,
      taxeringsvardeBostader: 50_000_000,
      taxeringsvardeLokaler: 0,
      vardear: 2010,
    })
    // 2018 is not in the takbelopp table: the amount is unknown, the reduction still known.
    expect(half.bostader.capPerLagenhet).toBeNull()
    expect(half.bostader.amount).toBeNull()
    expect(half.bostader.reduction).toBe('half')
    expect(half.warnings.some((w) => w.includes('Takbeloppet'))).toBe(true)

    const exempt = computeFastighetsavgift({
      incomeYear: 2026,
      antalBostadslagenheter: 10,
      taxeringsvardeBostader: 50_000_000,
      taxeringsvardeLokaler: 1_000_000,
      vardear: 2019,
    })
    expect(exempt.bostader.amount).toBe(0)
    expect(exempt.bostader.ink2Field).toBe('1.9 (befriad)')
    expect(exempt.lokaler.amount).toBe(10_000)
    expect(exempt.total).toBe(10_000)
    expect(exempt.statuteBasis.some((s) => s.includes('6 §'))).toBe(true)
  })

  it('returns null amounts and names every missing fact', () => {
    const c = computeFastighetsavgift({
      incomeYear: 2026,
      antalBostadslagenheter: null,
      taxeringsvardeBostader: null,
      taxeringsvardeLokaler: null,
      vardear: null,
    })
    expect(c.bostader.amount).toBeNull()
    expect(c.lokaler.amount).toBeNull()
    expect(c.total).toBeNull()
    expect(c.warnings).toHaveLength(4)
  })
})
