/**
 * The K10 underlag under the 3:12 rules from inkomstår 2026 (IL 57 kap.
 * after SFS 2025:1361), worked through with the figures of the
 * swedish-tax-planning skill: grundbelopp 4 x 80 600 = 322 400 kr, the
 * lönebaserat utrymme 50 % x (ägarandel x löneunderlag - 8 x 80 600),
 * capped at 50 x own cash pay, interest (omkostnadsbelopp - 100 000) x
 * (2.55 % + 9 pp) = 11.55 %, sparat utdelningsutrymme carried without
 * uplift, and the takbelopp 90 x 83 400 = 7 506 000 kr.
 */
import { describe, expect, it } from 'vitest'
import { computeK10, type K10Input } from '../k10-math'
import { k10Parameters, supportedK10Years } from '../k10-parameters'

const P2026 = k10Parameters(2026)!

function input(over: Partial<Omit<K10Input, 'dividend'>> & { payroll?: number; ownPay?: number; cost?: number; saved?: number; div?: number } = {}): K10Input {
  const { payroll = 0, ownPay = 0, cost = 25_000, saved = 0, div = 0, ...rest } = over
  return {
    params: P2026,
    shares_at_start: 1_000,
    total_shares_at_start: 1_000,
    uses_basic_amount: true,
    payroll_base: { amount: payroll, source: 'payroll', detail_sv: '' },
    own_pay: { amount: ownPay, source: 'payroll', detail_sv: '' },
    cost_basis: { amount: cost, source: 'register', detail_sv: '' },
    saved_dividend_space: { amount: saved, source: 'owner', detail_sv: '' },
    dividend: { amount: div, source: 'ledger', detail_sv: '' },
    ...rest,
  }
}

function line(result: ReturnType<typeof computeK10>, key: string): number {
  return result.lines.find((l) => l.key === key)!.amount
}

describe('k10 parameters', () => {
  it('holds the published 2026 figures and nothing before the reform', () => {
    expect(P2026).toEqual({ income_year: 2026, ibb_prior_year: 80_600, ibb_income_year: 83_400, slr_percent: 2.55 })
    expect(k10Parameters(2025)).toBeNull()
    expect(k10Parameters(2027)).toBeNull()
    expect(supportedK10Years()).toEqual([2026])
  })
})

describe('computeK10', () => {
  it('one owner of every share: grundbelopp, lönebaserat utrymme, no interest below 100 000 kr', () => {
    const r = computeK10(input({ payroll: 1_500_000, ownPay: 600_000 }))
    expect(line(r, 'ownership_share')).toBe(100)
    expect(line(r, 'basic_amount_company')).toBe(322_400)
    expect(r.basic_amount).toBe(322_400)
    expect(line(r, 'payroll_deduction')).toBe(644_800)
    // 50 % x (1 500 000 - 644 800) = 427 600, far under 50 x 600 000.
    expect(r.wage_space).toBe(427_600)
    expect(line(r, 'own_pay_cap')).toBe(30_000_000)
    expect(line(r, 'interest_rate')).toBe(11.55)
    expect(r.capital_interest).toBe(0)
    expect(r.annual_limit).toBe(750_000)
    expect(r.total_limit).toBe(750_000)
    expect(r.saved_space_carried_forward).toBe(750_000)
    // Every line names where it comes from.
    expect(r.lines.every((l) => l.source && typeof l.detail_sv === 'string')).toBe(true)
  })

  it('two owners with different holdings: each gets their share, and no own pay caps the lönebaserat utrymme at 0', () => {
    const anna = computeK10(input({ shares_at_start: 600, payroll: 3_000_000, ownPay: 700_000, cost: 300_000 }))
    const bo = computeK10(input({ shares_at_start: 400, payroll: 3_000_000, ownPay: 0, cost: 15_000 }))
    expect(anna.basic_amount).toBe(193_440)
    expect(bo.basic_amount).toBe(128_960)
    // 50 % x (0.6 x 3 000 000 - 644 800) = 577 600.
    expect(anna.wage_space).toBe(577_600)
    // 50 % x (0.4 x 3 000 000 - 644 800) = 277 600 before the cap; 50 x 0 = 0.
    expect(line(bo, 'wage_space_before_cap')).toBe(277_600)
    expect(bo.wage_space).toBe(0)
    // (300 000 - 100 000) x 11.55 % = 23 100.
    expect(anna.capital_interest).toBe(23_100)
    expect(anna.annual_limit).toBe(794_140)
    expect(bo.annual_limit).toBe(128_960)
  })

  it('the 8 IBB deduction leaves nothing for a small share of a small löneunderlag', () => {
    const r = computeK10(input({ shares_at_start: 100, payroll: 1_000_000, ownPay: 500_000 }))
    expect(line(r, 'payroll_owner_share')).toBe(100_000)
    expect(r.wage_space).toBe(0)
  })

  it('a dividend above the gränsbelopp: 2/3 of the part within in kapital, the rest as tjänst', () => {
    const r = computeK10(input({ div: 1_000_000 }))
    expect(r.total_limit).toBe(322_400)
    expect(r.dividend_within_limit).toBe(322_400)
    expect(line(r, 'dividend_capital_taxable')).toBe(214_933.33)
    expect(r.dividend_service).toBe(677_600)
    expect(r.dividend_above_ceiling).toBe(0)
    expect(r.saved_space_carried_forward).toBe(0)
  })

  it('dividend above the takbelopp of 90 IBB goes back to kapital', () => {
    const r = computeK10(input({ div: 8_000_000 }))
    expect(r.dividend_service).toBe(7_506_000)
    expect(r.dividend_above_ceiling).toBe(171_600)
  })

  it('sparat utdelningsutrymme is carried forward without uplift', () => {
    const r = computeK10(input({ saved: 100_000, div: 50_000 }))
    expect(line(r, 'saved_space_brought_forward')).toBe(100_000)
    expect(r.total_limit).toBe(422_400)
    expect(r.dividend_within_limit).toBe(50_000)
    expect(r.saved_space_carried_forward).toBe(372_400)
  })

  it('no grundbelopp when the owner uses it in another company', () => {
    const r = computeK10(input({ uses_basic_amount: false }))
    expect(r.basic_amount).toBe(0)
    expect(r.lines.find((l) => l.key === 'basic_amount')!.source).toBe('owner')
  })

  it('an owner with no shares at the start of the year has no gränsbelopp of their own', () => {
    const r = computeK10(input({ shares_at_start: 0, payroll: 2_000_000, ownPay: 600_000, div: 10_000 }))
    expect(r.basic_amount).toBe(0)
    expect(r.wage_space).toBe(0)
    expect(r.dividend_service).toBe(10_000)
  })
})
