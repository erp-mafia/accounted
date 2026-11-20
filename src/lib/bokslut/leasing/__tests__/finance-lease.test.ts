import { describe, expect, it } from 'vitest'
import {
  initialRecognitionLines,
  leaseSchedule,
  leaseYear,
  yearEndLines,
  type FinanceLease,
  type LeaseAccounts,
  type LeaseLine,
} from '../finance-lease'

const ACCOUNTS: LeaseAccounts = {
  asset: '1227',
  accumulatedDepreciation: '1229',
  liability: '2399',
  accruedInterest: '2960',
  leaseCost: '5220',
  interest: '8419',
  depreciation: '7836',
}

function lease(overrides: Partial<FinanceLease> = {}): FinanceLease {
  return {
    id: 'l1',
    name: 'Grävmaskin',
    startDate: '2026-01-01',
    fairValue: 100_000,
    payment: 40_000,
    numberOfPayments: 3,
    periodsPerYear: 1,
    paymentsInAdvance: false,
    guaranteedResidual: 0,
    annualRatePercent: 10,
    directCosts: 0,
    usefulLifeMonths: 60,
    ownershipTransfers: false,
    ...overrides,
  }
}

const balanced = (lines: LeaseLine[]) =>
  Math.abs(lines.reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)) < 0.005
const net = (lines: LeaseLine[], account: string) =>
  lines.filter((l) => l.account_number === account).reduce((sum, l) => sum + l.debit_amount - l.credit_amount, 0)

describe('finansiell leasing, leasetagare (K3 20.5-20.11)', () => {
  it('recognises the lower of verkligt värde and the nuvärde, and amortises it by the effective interest method', () => {
    // Three annual payments of 40 000 in arrears at 10 %: nuvärde 99 474,08.
    const schedule = leaseSchedule(lease())
    expect(schedule.presentValue).toBe(99_474.08)
    expect(schedule.initialLiability).toBe(99_474.08)
    expect(schedule.rows.map((r) => [r.date, r.interest, r.amortisation, r.liability])).toEqual([
      ['2027-01-01', 9_947.41, 30_052.59, 69_421.49],
      ['2028-01-01', 6_942.15, 33_057.85, 36_363.64],
      ['2029-01-01', 3_636.36, 36_363.64, 0],
    ])
  })

  it('takes the verkligt värde when it is lower, at the rate that amortises it to zero', () => {
    const schedule = leaseSchedule(lease({ fairValue: 95_000 }))
    expect(schedule.initialLiability).toBe(95_000)
    expect(schedule.ratePerPeriod).toBeGreaterThan(0.1)
    expect(schedule.rows.at(-1)?.liability).toBe(0)
    const interest = schedule.rows.reduce((sum, r) => sum + r.interest, 0)
    expect(Math.round(interest)).toBe(120_000 - 95_000)
  })

  it('adds direct costs to the asset only, and depreciates over the lease term unless ownership passes', () => {
    const schedule = leaseSchedule(lease({ directCosts: 2_000 }))
    expect(schedule.initialAsset).toBe(101_474.08)
    expect(schedule.depreciationMonths).toBe(36)
    expect(leaseSchedule(lease({ ownershipTransfers: true })).depreciationMonths).toBe(60)
    const lines = initialRecognitionLines(lease({ directCosts: 2_000 }), schedule, ACCOUNTS, '6550')
    expect(balanced(lines)).toBe(true)
    expect(net(lines, '1227')).toBe(101_474.08)
    expect(net(lines, '2399')).toBe(-99_474.08)
  })

  it('charges each year the interest of the liability during it, accrued, not paid (20.9)', () => {
    const l = lease()
    const schedule = leaseSchedule(l)
    const first = leaseYear(l, schedule, '2026-01-01', '2026-12-31')
    // No payment falls in 2026, but the year carries the full first period's interest.
    expect(first.payments).toBe(0)
    expect(first.interestExpense).toBe(9_947.41)
    expect(first.accruedInterest).toBe(9_947.41)
    expect(first.closingLiability).toBe(99_474.08)
    expect(first.dueWithinOneYear).toBe(30_052.59)
    expect(first.depreciation).toBe(33_158.03) // 99 474,08 over 36 months, 12 of them

    const lines = yearEndLines(l, first, ACCOUNTS, 0)
    expect(balanced(lines)).toBe(true)
    expect(net(lines, '8419')).toBe(9_947.41)
    expect(net(lines, '2960')).toBe(-9_947.41)

    const second = leaseYear(l, schedule, '2027-01-01', '2027-12-31')
    const secondLines = yearEndLines(l, second, ACCOUNTS, first.accruedInterest)
    expect(balanced(secondLines)).toBe(true)
    expect(net(secondLines, '5220')).toBe(-40_000)
    expect(net(secondLines, '2399')).toBe(30_052.59)
    expect(net(secondLines, '8419')).toBe(second.interestExpense)
    expect(second.interestExpense).toBe(6_942.15)
  })

  it('handles monthly payments in advance across a broken financial year, depreciating to zero', () => {
    const l = lease({ payment: 3_000, numberOfPayments: 36, periodsPerYear: 12, paymentsInAdvance: true, startDate: '2026-03-01' })
    const schedule = leaseSchedule(l)
    expect(schedule.rows[0].interest).toBe(0)
    expect(schedule.rows.at(-1)?.liability).toBe(0)
    let accrued = 0
    let depreciated = 0
    for (const [from, to] of [['2025-07-01', '2026-06-30'], ['2026-07-01', '2027-06-30'], ['2027-07-01', '2028-06-30'], ['2028-07-01', '2029-06-30']]) {
      const year = leaseYear(l, schedule, from, to)
      const lines = yearEndLines(l, year, ACCOUNTS, accrued)
      expect(balanced(lines)).toBe(true)
      accrued = year.accruedInterest
      depreciated += year.depreciation
    }
    expect(Math.abs(depreciated - schedule.initialAsset)).toBeLessThan(0.005)
  })
})
