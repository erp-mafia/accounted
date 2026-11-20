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

// Expansionsfond (IL 34 kap; NE R35-R37). Skatteverket, Expansionsfond: the
// ökning is "högst inkomsten i näringsverksamheten före avsättning till
// expansionsfond", the sum in R35, and the whole fund at most 125,94 % of the
// kapitalunderlag at year-end; a fund above that "måste" return the excess.
// A generous R35 isolates the 125,94 % cap.
const LARGE_R35 = 10_000_000

describe('Expansionsfond', () => {
  it('caps avsättning at 125.94 % of kapitalunderlag (Skatteverket: Johan, 100 000 gives 125 940)', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 0,
      desiredChange: 200_000, // would exceed 125 940 cap
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(r.item).not.toBeNull()
    expect(r.item!.amount).toBe(125_940)
    expect(r.r36).toBe(125_940)
    expect(r.item!.warnings[0]).toContain('125,94')
  })

  it('caps the ökning at R35, the result before it, as well', () => {
    // Before this fix R36 was 300 000 on an R35 of 120 000: an underskott
    // made by the avsättning, which the form forbids ("dock högst överskott
    // vid R35").
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 400_000,
      desiredChange: 300_000,
      resultBeforeExpansionsfond: 120_000,
    })
    expect(r.r36).toBe(120_000)
    expect(r.item).toMatchObject({ kind: 'expansionsfond_avsattning', amount: 120_000, ne_ruta: 'R36' })
    expect(r.item!.warnings[0]).toContain('R35')
  })

  it('allows no ökning on a loss', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 400_000,
      desiredChange: 50_000,
      resultBeforeExpansionsfond: -10_000,
    })
    expect(r.r36).toBe(0)
  })

  it('limits återföring to existing balance', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 30_000,
      desiredChange: -50_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(r.item!.kind).toBe('expansionsfond_ateforing')
    expect(r.item!.amount).toBe(30_000)
    expect(r.r37).toBe(30_000)
  })

  it('allows a minskning in a loss year (Skatteverket: Edin)', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 500_000,
      existingBalance: 200_000,
      desiredChange: -100_000,
      resultBeforeExpansionsfond: -100_000,
    })
    expect(r).toMatchObject({ r36: 0, r37: 100_000, newBalance: 100_000 })
  })

  it('returns the part of the fund above the cap even when nothing was asked', () => {
    // 125,94 % of 100 000 = 125 940; a fund of 200 000 must give back 74 060.
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 200_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(r).toMatchObject({ r36: 0, r37: 74_060, newBalance: 125_940 })
    expect(r.item).toMatchObject({ kind: 'expansionsfond_ateforing', ne_ruta: 'R37', amount: 74_060 })
    expect(r.item!.warnings[0]).toContain('måste återföras')
  })

  it('turns an asked ökning into the forced minskning when the fund is above the cap', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 200_000,
      desiredChange: 10_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(r).toMatchObject({ r36: 0, r37: 74_060 })
  })

  it('keeps an asked minskning larger than the forced one', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 200_000,
      desiredChange: -150_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(r.r37).toBe(150_000)
  })

  it('returns the whole fund when the kapitalunderlag is negative', () => {
    const r = calculateExpansionsfondChange({
      kapitalunderlag: -20_000,
      existingBalance: 50_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(r).toMatchObject({ r37: 50_000, newBalance: 0 })
  })

  it('forces nothing while the kapitalunderlag is not entered', () => {
    const r = calculateExpansionsfondChange({ existingBalance: 200_000, resultBeforeExpansionsfond: LARGE_R35 })
    expect(r).toMatchObject({ r36: 0, r37: 0, newBalance: 200_000, item: null })
  })

  it('returns no item when desiredChange is 0 and the fund fits', () => {
    expect(
      calculateExpansionsfondChange({ kapitalunderlag: 100_000, desiredChange: 0, resultBeforeExpansionsfond: LARGE_R35 })
        .item,
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
    const okning = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      desiredChange: 10_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(okning.item!.ne_ruta).toBe('R36')
    expect(okning.item!.description).toContain('punkt 12.1')

    const minskning = calculateExpansionsfondChange({
      kapitalunderlag: 100_000,
      existingBalance: 30_000,
      desiredChange: -10_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(minskning.item!.ne_ruta).toBe('R37')
    expect(minskning.item!.description).toContain('punkt 12.2')
  })

  it('expansionsfond: an avsättning capped to 0 is still an avsättning, not a återföring', () => {
    const { item: r } = calculateExpansionsfondChange({
      kapitalunderlag: 0,
      desiredChange: 10_000,
      resultBeforeExpansionsfond: LARGE_R35,
    })
    expect(r!.kind).toBe('expansionsfond_avsattning')
    expect(r!.ne_ruta).toBe('R36')
    expect(r!.amount).toBe(0)
    expect(r!.warnings[0]).toContain('125,94')
  })
})
