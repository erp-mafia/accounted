/**
 * Räntefördelning, NE R29-R31 (IL 33 kap). Worked examples are Skatteverket's
 * (Räntefördelning, inkomstår 2025: positive 7,96 %, negative 2,96 %) and the
 * swedish-ef-skatteplanering skill (rantefordelning-planning.md: SLR 1,96 %
 * for 2025, 2,55 % for 2026, 2,62 % for 2024).
 */
import { describe, it, expect } from 'vitest'
import {
  beskattningsarMonths,
  calculateRantefordelning,
  NEGATIVE_THRESHOLD,
  type RantefordelningInput,
} from '../enskild-firma/rantefordelning-calculator'

const Y2025 = { periodStart: '2025-01-01', periodEnd: '2025-12-31' }
const Y2026 = { periodStart: '2026-01-01', periodEnd: '2026-12-31' }

function rf(input: Partial<RantefordelningInput> & { kapitalunderlag: number }) {
  return calculateRantefordelning({ resultBeforeRantefordelning: 10_000_000, ...Y2025, ...input })
}

describe('calculateRantefordelning: the rate follows the inkomstår', () => {
  it('uses 7,96 % for inkomstår 2025 (Skatteverket: Dilba, 1 000 000 kr gives 79 600 kr)', () => {
    const r = rf({ kapitalunderlag: 1_000_000, resultBeforeRantefordelning: 300_000 })
    expect(r.r30).toBe(79_600)
    expect(r.items[0]).toMatchObject({ kind: 'rantefordelning_positive', amount: 79_600, ne_ruta: 'R30' })
    expect(r.items[0].computation).toMatchObject({ incomeYear: 2025, positiveRatePct: 7.96 })
  })

  it('uses 8,55 % for inkomstår 2026', () => {
    expect(rf({ kapitalunderlag: 1_000_000, ...Y2026 }).r30).toBe(85_500)
  })

  it('uses 2,96 % for negativ räntefördelning 2025 (Skatteverket: Emma, -1 000 000 kr gives 29 600 kr)', () => {
    const r = rf({ kapitalunderlag: -1_000_000, resultBeforeRantefordelning: 300_000 })
    expect(r.r31).toBe(29_600)
    expect(r.r30).toBe(0)
    expect(r.items[0]).toMatchObject({ kind: 'rantefordelning_negative', amount: 29_600, ne_ruta: 'R31' })
    expect(r.items[0].warnings[0]).toContain('-500 000')
  })

  it('uses 3,55 % for negativ räntefördelning 2026', () => {
    expect(rf({ kapitalunderlag: -600_000, ...Y2026 }).r31).toBe(21_300)
  })

  it('takes the rate of the year the beskattningsår ends in (brutet räkenskapsår)', () => {
    const r = rf({ kapitalunderlag: 1_000_000, periodStart: '2025-07-01', periodEnd: '2026-06-30' })
    expect(r.r30).toBe(85_500)
  })

  it('computes nothing for a year whose rate is not known yet, and says so', () => {
    const r = rf({ kapitalunderlag: 1_000_000, periodStart: '2027-01-01', periodEnd: '2027-12-31' })
    expect(r).toMatchObject({ r30: 0, r31: 0, sparatTillNastaAr: 0, items: [] })
    expect(r.warnings[0]).toMatch(/inkomstår 2027 är inte känd/)
    // No räntefördelning applies between -500 000 and 0 kr: nothing to say.
    expect(rf({ kapitalunderlag: -100_000, periodStart: '2027-01-01', periodEnd: '2027-12-31' }).warnings).toEqual([])
  })

  it('drops the öre (SFL 22 kap 1 §)', () => {
    // 333 333 x 7,96 % = 26 533,31
    expect(rf({ kapitalunderlag: 333_333 }).r30).toBe(26_533)
  })
})

describe('calculateRantefordelning: R30 is at most R29', () => {
  it('caps the deduction at the result before räntefördelning and saves the rest (Skatteverket: "Avdrag får inte överstiga inkomst")', () => {
    // Before this fix R30 was the whole 79 600 on a result of 50 000: an
    // underskott made by räntefördelning, which the form forbids.
    const r = rf({ kapitalunderlag: 1_000_000, resultBeforeRantefordelning: 50_000 })
    expect(r.r30).toBe(50_000)
    expect(r.sparatTillNastaAr).toBe(29_600)
    expect(r.kapitalunderlagRequired).toBe(true)
    expect(r.items[0].warnings.join(' ')).toContain('sparas till nästa år')
  })

  it('deducts nothing on a loss and saves the whole fördelningsbelopp', () => {
    const r = rf({ kapitalunderlag: 1_000_000, resultBeforeRantefordelning: -20_000 })
    expect(r.r30).toBe(0)
    expect(r.sparatTillNastaAr).toBe(79_600)
    expect(r.kapitalunderlagRequired).toBe(true)
  })
})

describe('calculateRantefordelning: sparat fördelningsbelopp', () => {
  it('uses the sparat belopp on top of the year\'s (Skatteverket: Håkan, 8 756 + 10 000 = 18 756)', () => {
    // Kapitalunderlag 100 000 plus the sparat 10 000 = 110 000, as on SKV 2196.
    const r = rf({ kapitalunderlag: 110_000, sparatFordelningsbelopp: 10_000 })
    expect(r.r30).toBe(18_756)
    expect(r.sparatTillNastaAr).toBe(0)
  })

  it('uses a sparat belopp with a negative kapitalunderlag from 2025', () => {
    const r = rf({ kapitalunderlag: -100_000, sparatFordelningsbelopp: 20_000 })
    expect(r).toMatchObject({ r30: 20_000, r31: 0, sparatTillNastaAr: 0 })
  })

  it('carries an unused sparat belopp forward with the year\'s', () => {
    const r = rf({ kapitalunderlag: 110_000, sparatFordelningsbelopp: 10_000, resultBeforeRantefordelning: 5_000 })
    expect(r.r30).toBe(5_000)
    expect(r.sparatTillNastaAr).toBe(13_756)
  })
})

describe('calculateRantefordelning: limits', () => {
  it('returns nothing between 0 and the -500 000 negative threshold (2025)', () => {
    for (const kapitalunderlag of [0, -100_000, NEGATIVE_THRESHOLD]) {
      const r = rf({ kapitalunderlag })
      expect(r.items).toEqual([])
      expect(r).toMatchObject({ r30: 0, r31: 0, kapitalunderlagRequired: false })
    }
  })

  it('keeps the ±50 000 kr limits for a beskattningsår that began before 2025 (2,62 % SLR)', () => {
    const Y2024 = { periodStart: '2024-01-01', periodEnd: '2024-12-31' }
    expect(rf({ kapitalunderlag: 40_000, ...Y2024 }).items).toEqual([])
    expect(rf({ kapitalunderlag: 100_000, ...Y2024 }).r30).toBe(8_620)
    expect(rf({ kapitalunderlag: -60_000, ...Y2024 }).r31).toBe(2_172)
  })
})

describe('calculateRantefordelning: jämkning for a year that is not twelve months', () => {
  it('counts the calendar months of the beskattningsår', () => {
    expect(beskattningsarMonths('2025-01-01', '2025-12-31')).toBe(12)
    expect(beskattningsarMonths('2025-04-01', '2025-12-31')).toBe(9)
    expect(beskattningsarMonths('2025-05-01', '2026-12-31')).toBe(20)
  })

  it('takes 9/12 of the fördelningsbelopp for a nine-month year (Skatteverket: 120 000 x 9 / 12)', () => {
    const r = rf({ kapitalunderlag: 1_000_000, periodStart: '2025-04-01', periodEnd: '2025-12-31' })
    expect(r.r30).toBe(59_700)
    expect(r.items[0].description).toContain('9 av 12 månader')
  })

  it('jämkar the negative one the same way', () => {
    const r = rf({ kapitalunderlag: -1_000_000, periodStart: '2025-04-01', periodEnd: '2025-12-31' })
    expect(r.r31).toBe(22_200)
  })
})

describe('calculateRantefordelning: what the card says', () => {
  it('names INK1 punkt 11.1 for R30 and 11.2 for R31, not an old T4 field', () => {
    const positive = rf({ kapitalunderlag: 1_000_000 }).items[0]
    const negative = rf({ kapitalunderlag: -1_000_000 }).items[0]
    expect(positive.description).toContain('punkt 11.1')
    expect(negative.description).toContain('punkt 11.2')
    expect(`${positive.description} ${negative.description}`).not.toContain('T4')
  })
})
