import { describe, it, expect } from 'vitest'
import { calculateLoneVaxling } from '../lonevaxling'
import type { PayrollConfig } from '../payroll-config'

const config: PayrollConfig = {
  configYear: 2026,
  avgifterTotal: 0.3142,
  avgifterAlderspension: 0.1021,
  avgifterSjukforsakring: 0.0355,
  avgifterForaldraforsakring: 0.0200,
  avgifterEfterlevandepension: 0.0030,
  avgifterArbetsmarknad: 0.0264,
  avgifterArbetsskada: 0.0010,
  avgifterAllmanLoneavgift: 0.1262,
  avgifterReduced65plus: 0.1021,
  avgifterYouthRate: 0.2081,
  avgifterYouthSalaryCap: 25000,
  avgifterVaxaStodRate: 0.1021,
  avgifterVaxaStodCap: 35000,
  avgifterMinimumAnnual: 1000,
  egenavgifterTotal: 0.2897,
  slpRate: 0.2426,
  prisbasbelopp: 59200,
  inkomstbasbelopp: 83400,
  maxPgi: 625500,
  sgiCeiling: 592000,
  statligSkattBrytpunkt: 660400,
  traktamenteHeldag: 300,
  traktamenteHalvdag: 150,
  traktamenteNatt: 150,
  milersattningEgenBil: 25,
  milersattningFormansbilFossil: 12,
  milersattningFormansbilEl: 9.50,
  kostformanHeldag: 310,
  kostformanLunch: 124,
  kostformanFrukost: 62,
  friskvardCap: 5000,
  bilformanSlr: 0.0255,
  sjuklonRate: 0.80,
  karensavdragFactor: 0.20,
  maxKarensavdragPerYear: 10,
  reducedAvgiftAge: 67,
}

const r = (x: number) => Math.round(x * 100) / 100

describe('calculateLoneVaxling', () => {
  it('applies 1.058 factor to pension contribution', () => {
    const result = calculateLoneVaxling(5000, 60000, config)
    expect(result.pensionContribution).toBe(r(5000 * 1.058))
  })

  it('reduces salary by exact reduction amount', () => {
    const result = calculateLoneVaxling(5000, 60000, config)
    expect(result.postReductionSalary).toBe(55000)
  })

  it('calculates saved avgifter', () => {
    const result = calculateLoneVaxling(5000, 60000, config)
    expect(result.savedAvgifter).toBe(r(5000 * 0.3142))
  })

  it('calculates SLP on pension at 24.26%', () => {
    const result = calculateLoneVaxling(5000, 60000, config)
    const expectedSlp = r(5000 * 1.058 * 0.2426)
    expect(result.slpOnPension).toBe(expectedSlp)
  })

  it('warns when post-reduction salary drops below PGI floor', () => {
    // PGI floor = 8.07 × 83400 / 12 ≈ 56,088.50
    const result = calculateLoneVaxling(20000, 60000, config)
    // Post-reduction: 40,000 < 56,088
    expect(result.warnings.length).toBeGreaterThan(0)
    expect(result.warnings[0]).toContain('PGI-golv')
  })

  it('does not warn when salary stays above PGI floor', () => {
    const result = calculateLoneVaxling(3000, 80000, config)
    // Post-reduction: 77,000 > PGI floor
    const pgiWarnings = result.warnings.filter(w => w.includes('PGI'))
    expect(pgiWarnings.length).toBe(0)
  })

  it('warns when annual pension exceeds 10 × PBB cap', () => {
    // Cap = 10 × 59200 = 592,000 SEK/year
    // Monthly contribution = 50000 × 1.058 = 52,900 → annual = 634,800 > 592,000
    const result = calculateLoneVaxling(50000, 100000, config)
    expect(result.warnings.some(w => w.includes('PBB'))).toBe(true)
  })

  it('returns calculation steps for transparency', () => {
    const result = calculateLoneVaxling(5000, 60000, config)
    expect(result.steps.length).toBeGreaterThanOrEqual(5)
    expect(result.steps.some(s => s.label === 'Pensionsavsättning')).toBe(true)
    expect(result.steps.some(s => s.label === 'Särskild löneskatt på pension')).toBe(true)
  })
})
