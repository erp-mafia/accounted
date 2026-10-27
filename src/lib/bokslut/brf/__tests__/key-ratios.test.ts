import { describe, expect, it } from 'vitest'
import {
  buildBrfKeyRatioTable,
  computeBrfKeyRatios,
  ledgerFactsForKeyRatios,
  type BrfKeyRatioYearInput,
} from '../key-ratios'
import type { TrialBalanceRow } from '@/types'

function year(overrides: Partial<BrfKeyRatioYearInput> = {}): BrfKeyRatioYearInput {
  return {
    period_end: '2026-12-31',
    arsavgifter: 0,
    rorelseintakter: 0,
    rantebarande_skulder: 0,
    energikostnader: { varme: 0, el: 0, vatten: 0 },
    arets_resultat: 0,
    avskrivningar: 0,
    utrangeringar: 0,
    planerat_underhall: 0,
    ej_normal_verksamhet: { intakter: 0, kostnader: 0 },
    kvm_bostadsratt: 0,
    kvm_hyresratt: 0,
    ...overrides,
  }
}

describe('BRF key ratios: the K3 kapitel 38 examples', () => {
  it('årsavgift per kvm upplåten med bostadsrätt (38.6): 7 750 000 / 12 500 = 620', () => {
    // The varmvatten fee by consumption is in the årsavgift; internet and parking are not.
    const ratios = computeBrfKeyRatios(year({ arsavgifter: 7_500_000 + 250_000, kvm_bostadsratt: 12_500 }))
    expect(ratios.arsavgift_per_kvm_bostadsratt).toBe(620)
  })

  it('skuldsättning per kvm and per kvm upplåten med bostadsrätt (38.7)', () => {
    const ratios = computeBrfKeyRatios(year({
      rantebarande_skulder: 100_000_000, kvm_bostadsratt: 12_500, kvm_hyresratt: 300 + 2_000,
    }))
    // 6 757 kr/kvm in the example, which rounds to whole kronor.
    expect(ratios.skuldsattning_per_kvm).toBe(6756.76)
    expect(ratios.skuldsattning_per_kvm_bostadsratt).toBe(8000)
  })

  it('sparande per kvm (38.8): justerat resultat 7 050 000 / 12 500 = 564', () => {
    const ratios = computeBrfKeyRatios(year({
      arets_resultat: 700_000,
      avskrivningar: 5_000_000,
      planerat_underhall: 1_350_000,
      kvm_bostadsratt: 11_200,
      kvm_hyresratt: 300 + 1_000,
    }))
    expect(ratios.justerat_resultat).toBe(7_050_000)
    expect(ratios.sparande_per_kvm).toBe(564)
  })

  it('adds back väsentliga kostnader and deducts väsentliga intäkter outside the normal activity', () => {
    const ratios = computeBrfKeyRatios(year({
      arets_resultat: 100_000,
      utrangeringar: 20_000,
      ej_normal_verksamhet: { intakter: 50_000, kostnader: 10_000 },
      kvm_bostadsratt: 1_000,
    }))
    expect(ratios.justerat_resultat).toBe(80_000)
    expect(ratios.sparande_per_kvm).toBe(80)
  })

  it('räntekänslighet (38.9): 100 000 000 / 7 750 000 = 12,90 %', () => {
    const ratios = computeBrfKeyRatios(year({ rantebarande_skulder: 100_000_000, arsavgifter: 7_750_000 }))
    expect(ratios.rantekanslighet).toBe(12.9)
  })

  it('energikostnad per kvm (38.10) and årsavgifternas andel (38.11)', () => {
    const ratios = computeBrfKeyRatios(year({
      energikostnader: { varme: 600_000, el: 250_000, vatten: 150_000 },
      kvm_bostadsratt: 9_000,
      kvm_hyresratt: 1_000,
      arsavgifter: 4_000_000,
      rorelseintakter: 5_000_000,
    }))
    expect(ratios.energikostnad_per_kvm).toBe(100)
    expect(ratios.arsavgifternas_andel_av_rorelseintakter).toBe(80)
  })

  it('answers null instead of dividing by zero', () => {
    const ratios = computeBrfKeyRatios(year())
    expect(ratios.arsavgift_per_kvm_bostadsratt).toBeNull()
    expect(ratios.rantekanslighet).toBeNull()
    expect(ratios.arsavgifternas_andel_av_rorelseintakter).toBeNull()
  })
})

describe('BRF key ratio table (38.5)', () => {
  it('keeps the four newest years, newest first, and flags a shorter history and missing facts', () => {
    const years = ['2022', '2023', '2024', '2025', '2026'].map((y) => year({
      period_end: `${y}-12-31`, arsavgifter: 1, rorelseintakter: 1, kvm_bostadsratt: 1,
    }))
    const table = buildBrfKeyRatioTable(years)
    expect(table.years.map((y) => y.period_end)).toEqual(['2026-12-31', '2025-12-31', '2024-12-31', '2023-12-31'])
    expect(table.issues).toEqual([])

    const short = buildBrfKeyRatioTable([year({ period_end: '2026-12-31' })])
    expect(short.issues.map((issue) => issue.code)).toEqual([
      'BRF_KEY_RATIOS_FEWER_THAN_FOUR_YEARS',
      'BRF_KEY_RATIOS_NO_AREA',
      'BRF_KEY_RATIOS_NO_ARSAVGIFTER',
      'BRF_KEY_RATIOS_NO_RORELSEINTAKTER',
    ])
  })
})

describe('ledgerFactsForKeyRatios', () => {
  const row = (account: string, debit: number, credit: number, closing = 0): TrialBalanceRow => ({
    account_number: account,
    account_name: account,
    account_class: Number(account[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: debit,
    period_credit: credit,
    closing_debit: closing > 0 ? closing : 0,
    closing_credit: closing < 0 ? -closing : 0,
  })

  it('reads the mapped accounts, interest-bearing debt by default and the result before the resultatavslut', () => {
    const facts = ledgerFactsForKeyRatios([
      row('3010', 0, 4_000_000),
      row('3020', 0, 600_000),
      row('4610', 500_000, 0), // värme
      row('4620', 200_000, 0), // el
      row('4630', 100_000, 0), // vatten
      row('5170', 300_000, 0), // planerat underhåll
      row('7820', 900_000, 0),
      row('8410', 1_000_000, 0),
      row('2351', 0, 0, -40_000_000),
      row('2417', 0, 0, -2_000_000),
      row('2440', 0, 0, -150_000),
    ], {
      arsavgifter: ['3010'],
      energi: { varme: ['4610'], el: ['4620'], vatten: ['4630'] },
      planerat_underhall: ['5170'],
      utrangeringar: [],
    })
    expect(facts.arsavgifter).toBe(4_000_000)
    expect(facts.rorelseintakter).toBe(4_600_000)
    expect(facts.energikostnader).toEqual({ varme: 500_000, el: 200_000, vatten: 100_000 })
    expect(facts.planerat_underhall).toBe(300_000)
    expect(facts.avskrivningar).toBe(900_000)
    expect(facts.rantebarande_skulder).toBe(42_000_000)
    expect(facts.arets_resultat).toBe(1_600_000)
  })
})
