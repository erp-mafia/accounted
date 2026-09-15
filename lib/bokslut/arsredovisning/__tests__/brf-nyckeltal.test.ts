/**
 * Nyckeltal of a bostadsrättsförening (ÅRL 6 kap. 3 a §, BFNAR 2012:1 punkt
 * 38.3-38.9). The expectations are the worked examples in BFN's chapter 38
 * text (remiss Dnr 2022:51, examples under 38.5-38.8) so a definition drift
 * shows up as a number, not a label.
 */
import { describe, expect, it } from 'vitest'
import {
  BRF_NYCKELTAL_ACCOUNTS,
  buildingCarryingAmount,
  computeBrfNettoomsattningSplit,
  computeBrfNyckeltal,
  missingBrfFacts,
  sumCredit,
} from '../brf-nyckeltal'

type Row = { account_number: string; closing_debit: number; closing_credit: number }

function credit(account: string, amount: number): Row {
  return { account_number: account, closing_debit: 0, closing_credit: amount }
}
function debit(account: string, amount: number): Row {
  return { account_number: account, closing_debit: amount, closing_credit: 0 }
}

// BFN's example: årsavgifter 7 500 000, avgift efter förbrukning 250 000,
// tillval (internet) 40 000, parkering 1 250 000, lokalhyra 750 000, lån
// 100 000 000, 12 500 kvm bostadsrätt, 300 kvm lokaler and a 2 000 kvm garage
// med hyresrätt; årets resultat 1 700 000, avskrivningar 4 000 000, planerat
// underhåll 1 350 000.
const rr: Row[] = [
  credit('3020', 7_500_000),
  credit('3022', 250_000),
  credit('3030', 40_000),
  credit('3014', 1_250_000),
  credit('3012', 750_000),
  debit('7830', 4_000_000),
  debit('5170', 1_350_000),
  debit('5310', 400_000),
  debit('5370', 900_000),
  debit('5380', 200_000),
]
const br: Row[] = [credit('2350', 100_000_000), debit('1110', 250_000_000), credit('1119', 40_000_000)]

const facts = { kvm_bostadsratt: 12_500, kvm_hyresratt: 2_000, kvm_lokaler: 300, kvm_lokaler_bostadsratt: null }

function compute(
  overrides?: Parameters<typeof computeBrfNyckeltal>[0]['overrides'],
  f: Parameters<typeof computeBrfNyckeltal>[0]['facts'] = facts,
) {
  return computeBrfNyckeltal({
    year: '2026',
    preClosingRows: rr,
    fullRows: br,
    resultat_efter_finansiella_poster: 1_700_000,
    soliditet_pct: 42.3,
    arets_resultat: 1_700_000,
    facts: f,
    overrides,
  })
}

describe('computeBrfNyckeltal (BFN chapter 38 examples)', () => {
  it('årsavgift per kvm upplåten med bostadsrätt: 7 750 000 / 12 500 = 620 (38.5)', () => {
    const row = compute()
    expect(row.underlag.arsavgifter).toBe(7_750_000)
    expect(row.arsavgift_per_kvm_bostadsratt).toBe(620)
    // Tillval and parkering are not årsavgift.
    expect(row.underlag.arsavgifter_bostader).toBe(7_750_000)
  })

  it('skuldsättning per kvm over every charged area and over bostadsrätt alone (38.6, 38.3 d)', () => {
    const row = compute()
    // 100 000 000 / (12 500 + 2 000 + 300) = 6 757
    expect(row.skuldsattning_per_kvm).toBe(6_757)
    // 100 000 000 / 12 500 = 8 000
    expect(row.skuldsattning_per_kvm_bostadsratt).toBe(8_000)
  })

  it('sparande per kvm from justerat resultat (38.7)', () => {
    // BFN: 1 700 000 + 4 000 000 + 1 350 000 = 7 050 000 over 12 500 kvm = 564.
    const onlyBostadsratt = compute(undefined, { ...facts, kvm_hyresratt: 0, kvm_lokaler: 0 })
    expect(onlyBostadsratt.underlag.justerat_resultat).toBe(7_050_000)
    expect(onlyBostadsratt.sparande_per_kvm).toBe(564)
  })

  it('räntekänslighet: 1 % of 100 000 000 over årsavgifter 7 750 000 = 12,9 % (38.8)', () => {
    expect(compute().rantekanslighet_pct).toBe(12.9)
  })

  it('energikostnad per kvm sums BAS 53 over every charged area (38.9)', () => {
    const row = compute()
    expect(row.underlag.energikostnad).toBe(1_500_000)
    // 1 500 000 / 14 800 = 101,35 -> 101
    expect(row.energikostnad_per_kvm).toBe(101)
  })

  it('årsavgifternas andel of the total operating income (38.3 e)', () => {
    // 7 750 000 / (7 750 000 + 40 000 + 1 250 000 + 750 000) = 79,16 -> 79,2 %
    expect(compute().arsavgifternas_andel_pct).toBe(79.2)
  })

  it('applies the planerat underhåll override and the sparande adjustment (38.7)', () => {
    const row = compute({ planerat_underhall_override: 500_000, sparande_adjustment: -100_000 })
    expect(row.underlag.planerat_underhall).toBe(500_000)
    expect(row.underlag.sparande_adjustment).toBe(-100_000)
    expect(row.underlag.justerat_resultat).toBe(1_700_000 + 4_000_000 + 500_000 - 100_000)
  })

  it('splits årsavgift per kvm between bostäder and lokaler only when the lokal area is known (38.3 c)', () => {
    const none = compute()
    expect(none.arsavgift_per_kvm_lokaler).toBeNull()
    expect(none.arsavgift_per_kvm_bostader).toBe(620)
    const withLokaler = computeBrfNyckeltal({
      year: '2026',
      preClosingRows: [...rr, credit('3021', 250_000)],
      fullRows: br,
      resultat_efter_finansiella_poster: 0,
      soliditet_pct: null,
      arets_resultat: 0,
      facts: { ...facts, kvm_lokaler_bostadsratt: 500 },
    })
    expect(withLokaler.arsavgift_per_kvm_lokaler).toBe(500)
    expect(withLokaler.arsavgift_per_kvm_bostader).toBe(Math.round(7_750_000 / 12_000))
    expect(withLokaler.arsavgift_per_kvm_bostadsratt).toBe(640)
  })

  it('returns null ratios, never zero, when the area is missing', () => {
    const row = compute(undefined, null)
    expect(row.arsavgift_per_kvm_bostadsratt).toBeNull()
    expect(row.skuldsattning_per_kvm).toBeNull()
    expect(row.sparande_per_kvm).toBeNull()
    expect(row.energikostnad_per_kvm).toBeNull()
    // Ratios that need no area still compute.
    expect(row.rantekanslighet_pct).toBe(12.9)
    expect(row.nettoomsattning).toBe(9_790_000)
  })

  it('räntekänslighet is null without årsavgifter and skuldsättning counts only kreditinstitut', () => {
    const row = computeBrfNyckeltal({
      year: '2026',
      preClosingRows: [credit('3012', 100_000)],
      fullRows: [credit('2310', 5_000_000), credit('2410', 1_000_000), credit('2390', 300_000)],
      resultat_efter_finansiella_poster: 0,
      soliditet_pct: null,
      arets_resultat: 0,
      facts,
    })
    expect(row.rantekanslighet_pct).toBeNull()
    // Obligationslån 2310 and övriga långfristiga skulder 2390 are not skulder till kreditinstitut.
    expect(row.underlag.rantebarande_skulder).toBe(1_000_000)
  })
})

describe('computeBrfNettoomsattningSplit (38.13)', () => {
  it('splits the post by kind of income and keeps the remainder', () => {
    const split = computeBrfNettoomsattningSplit([...rr, credit('3021', 100_000), credit('3011', 200_000), credit('3100', 5_000)])
    expect(split).toEqual({
      arsavgifter_bostader: 7_750_000,
      arsavgifter_lokaler: 100_000,
      hyror_bostader: 200_000,
      hyror_lokaler: 750_000,
      hyror_garage_parkering: 1_250_000,
      ovriga_avgifter: 40_000,
      ovrigt: 5_000,
      total: 10_095_000,
    })
  })
})

describe('helpers', () => {
  it('missingBrfFacts names the areas the ratios need', () => {
    expect(missingBrfFacts(null)).toEqual(['kvm_bostadsratt', 'kvm_hyresratt', 'kvm_lokaler'])
    expect(missingBrfFacts({ kvm_bostadsratt: 0, kvm_hyresratt: 0, kvm_lokaler: null, kvm_lokaler_bostadsratt: null })).toEqual([
      'kvm_bostadsratt',
      'kvm_lokaler',
    ])
    expect(missingBrfFacts(facts)).toEqual([])
  })

  it('buildingCarryingAmount reads 1110-1118 and leaves accumulated depreciation on 1119 out', () => {
    expect(buildingCarryingAmount(br)).toBe(250_000_000)
    expect(buildingCarryingAmount([credit('1119', 1)])).toBe(0)
  })

  it('sumCredit nets debit and credit inside the ranges', () => {
    expect(sumCredit([credit('3020', 100), debit('3020', 30)], BRF_NYCKELTAL_ACCOUNTS.arsavgifterBostader)).toBe(70)
  })
})
