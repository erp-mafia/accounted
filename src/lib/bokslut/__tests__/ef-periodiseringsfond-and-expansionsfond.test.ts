import { describe, it, expect } from 'vitest'
import {
  classifyEfPfonder,
  proposeEfPfondAvsattning,
  proposeEfPfondAteforing,
} from '../enskild-firma/periodiseringsfond-ef'
import { calculateExpansionsfondChange } from '../enskild-firma/expansionsfond-calculator'

describe('EF periodiseringsfond: avsättning', () => {
  it('caps at 30 % of surplus (vs 25 % for AB)', () => {
    const r = proposeEfPfondAvsattning({ surplus: 100_000, fiscalYear: 2026, desiredAmount: 50_000 })
    expect(r).not.toBeNull()
    // max = 30 000, desired 50 000 → capped to 30 000
    expect(r!.amount).toBe(30_000)
    expect(r!.warnings[0]).toContain('30')
  })

  it('returns null on zero / negative surplus', () => {
    expect(proposeEfPfondAvsattning({ surplus: 0, fiscalYear: 2026 })).toBeNull()
    expect(proposeEfPfondAvsattning({ surplus: -1, fiscalYear: 2026 })).toBeNull()
  })
})

describe('EF periodiseringsfond: återföring', () => {
  it('forces full reversal of 6+ year old fonder', () => {
    const items = proposeEfPfondAteforing({
      existingFonder: [{ cohort_year: 2020, balance: 50_000 }],
      closingYear: 2026,
    })
    expect(items).toHaveLength(1)
    expect(items[0].amount).toBe(50_000)
    expect(items[0].warnings[0]).toContain('6-årsgränsen')
  })

  it('caps a voluntary återföring to the balance', () => {
    const items = proposeEfPfondAteforing({
      existingFonder: [{ cohort_year: 2023, balance: 20_000 }],
      closingYear: 2026,
      voluntaryAmount: 100_000,
    })
    expect(items[0].amount).toBe(20_000)
    expect(items[0].warnings).toEqual([])
  })

  // swedish-ef-skatteplanering, references/periodiseringsfond-expansionsfond-ef.md
  // (Återföring): a fund must return at the latest in the sixth year after the
  // avsättning, earlier återföring is voluntary; ne-bilaga-fields.md: R32
  // takes the oldest year first. No schablonintäkt for an enskild firma.
  it('returns a fund in its sixth year after the avsättning in full, and nothing younger unasked', () => {
    const items = proposeEfPfondAteforing({
      existingFonder: [
        { cohort_year: 2019, balance: 40_000 },
        { cohort_year: 2021, balance: 25_000 },
      ],
      closingYear: 2025,
    })
    expect(items).toHaveLength(1)
    expect(items[0].computation).toMatchObject({ cohort_year: 2019, latest_return_year: 2025, was_mandatory: true })
    expect(items[0].amount).toBe(40_000)
  })

  it('needs no återföring for a fund not yet due', () => {
    expect(
      proposeEfPfondAteforing({ existingFonder: [{ cohort_year: 2023, balance: 20_000 }], closingYear: 2026 }),
    ).toEqual([])
  })

  it('has nothing to return without funds', () => {
    expect(proposeEfPfondAteforing({ existingFonder: [], closingYear: 2026 })).toEqual([])
  })

  it('takes a voluntary återföring from the oldest fund first', () => {
    const items = proposeEfPfondAteforing({
      existingFonder: [
        { cohort_year: 2023, balance: 20_000 },
        { cohort_year: 2022, balance: 10_000 },
      ],
      closingYear: 2026,
      voluntaryAmount: 15_000,
    })
    expect(items.map((i) => [i.computation.cohort_year, i.amount])).toEqual([
      [2022, 10_000],
      [2023, 5_000],
    ])
  })

  it('returns a fund past its last year and says to check the earlier declaration', () => {
    const [item] = proposeEfPfondAteforing({
      existingFonder: [{ cohort_year: 2018, balance: 12_000 }],
      closingYear: 2026,
    })
    expect(item.amount).toBe(12_000)
    expect(item.warnings[0]).toContain('senast i 2024 års deklaration')
  })
})

describe('EF periodiseringsfond: fund states', () => {
  it('orders funds oldest first and marks each against the closing year', () => {
    const states = classifyEfPfonder(
      [
        { cohort_year: 2022, balance: 5_000 },
        { cohort_year: 2018, balance: 1_000 },
        { cohort_year: 2019, balance: 2_000 },
        { cohort_year: 2025, balance: 3_000 },
        { cohort_year: 2021, balance: 0 },
      ],
      2025,
    )
    expect(states.map((f) => [f.cohort_year, f.status, f.latest_return_year])).toEqual([
      [2018, 'overdue', 2024],
      [2019, 'mandatory', 2025],
      [2022, 'optional', 2028],
      [2025, 'invalid', 2031],
    ])
  })

  it('sums a repeated avsättningsår into one fund', () => {
    const states = classifyEfPfonder(
      [
        { cohort_year: 2022, balance: 1_000.1 },
        { cohort_year: 2022, balance: 2_000.2 },
      ],
      2025,
    )
    expect(states).toEqual([{ cohort_year: 2022, balance: 3_000.3, latest_return_year: 2028, status: 'optional' }])
  })
})

describe('Expansionsfond', () => {
  it('caps avsättning at 125.94 % of kapitalunderlag', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 0,
      desiredChange: 200_000, // would exceed 125 940 cap
    })
    expect(r).not.toBeNull()
    expect(r!.amount).toBe(125_940)
    expect(r!.warnings[0]).toContain('125,94')
  })

  it('limits återföring to existing balance', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 30_000,
      desiredChange: -50_000,
    })
    expect(r).not.toBeNull()
    expect(r!.kind).toBe('expansionsfond_ateforing')
    expect(r!.amount).toBe(30_000)
  })

  it('returns null when desiredChange is 0', () => {
    expect(
      calculateExpansionsfondChange({ kapitalunderlag: 100_000, desiredChange: 0 }),
    ).toBeNull()
  })
})

// Rutor per Skatteverket's NE-bilaga (SKV 2161): R32 återföring och R34
// avsättning periodiseringsfond, R36 ökning och R37 minskning expansionsfond.
describe('NE-bilaga rutor', () => {
  it('periodiseringsfond: avsättning in R34, återföring in R32', () => {
    const avsattning = proposeEfPfondAvsattning({ surplus: 100_000, fiscalYear: 2026 })
    expect(avsattning!.ne_ruta).toBe('R34')
    expect(avsattning!.description).toContain('R34')

    const [ateforing] = proposeEfPfondAteforing({
      existingFonder: [{ cohort_year: 2020, balance: 50_000 }],
      closingYear: 2026,
    })
    expect(ateforing.ne_ruta).toBe('R32')
    expect(ateforing.description).toContain('R32')
  })

  it('expansionsfond: ökning in R36, minskning in R37', () => {
    const okning = calculateExpansionsfondChange({ kapitalunderlag: 100_000, desiredChange: 10_000 })
    expect(okning!.ne_ruta).toBe('R36')

    const minskning = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 30_000,
      desiredChange: -10_000,
    })
    expect(minskning!.ne_ruta).toBe('R37')
  })

  it('expansionsfond: an avsättning capped to 0 is still an avsättning, not a återföring', () => {
    const r = calculateExpansionsfondChange({ kapitalunderlag: 0, desiredChange: 10_000 })
    expect(r!.kind).toBe('expansionsfond_avsattning')
    expect(r!.ne_ruta).toBe('R36')
    expect(r!.amount).toBe(0)
    expect(r!.warnings[0]).toContain('125,94')
  })
})
