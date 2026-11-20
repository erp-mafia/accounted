import { describe, it, expect } from 'vitest'
import {
  calculateLatePaymentInterest,
  getAnnualInterestRate,
  getReferensrantaAt,
} from '../late-payment-interest'

describe('getReferensrantaAt', () => {
  it('returns 0 for early 2022', () => {
    expect(getReferensrantaAt('2022-01-15')).toBe(0)
  })

  it('returns 0.005 for late 2022', () => {
    expect(getReferensrantaAt('2022-12-31')).toBe(0.005)
  })

  // Riksbanken's published table (riksbank.se, read 2026-10-26).
  it.each([
    ['2023-03-01', 0.025],
    ['2023-09-01', 0.035],
    ['2024-03-01', 0.04],
    ['2024-07-01', 0.04],
    ['2025-01-01', 0.03],
    ['2025-06-30', 0.03],
    ['2025-07-01', 0.02],
    ['2026-05-15', 0.02],
    ['2026-10-26', 0.02],
  ])('returns the published rate on %s', (date, rate) => {
    expect(getReferensrantaAt(date)).toBe(rate)
  })

  it('falls back to earliest entry for pre-2022 dates', () => {
    expect(getReferensrantaAt('2021-01-01')).toBe(0)
  })
})

describe('getAnnualInterestRate', () => {
  it('adds 8 percentage points to referensränta by default', () => {
    expect(getAnnualInterestRate('2026-05-01')).toBeCloseTo(0.1, 4)
  })

  it('uses the override rate when supplied', () => {
    expect(getAnnualInterestRate('2026-05-01', 0.115)).toBe(0.115)
  })

  it('respects override of 0 (interest-free)', () => {
    expect(getAnnualInterestRate('2026-05-01', 0)).toBe(0)
  })

  it('ignores undefined and null overrides', () => {
    expect(getAnnualInterestRate('2026-05-01', undefined)).toBeCloseTo(0.1, 4)
    expect(getAnnualInterestRate('2026-05-01', null)).toBeCloseTo(0.1, 4)
  })
})

describe('calculateLatePaymentInterest', () => {
  it('returns 0 when invoice is not yet overdue', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-06-01',
      asOfDate: '2026-05-15',
    })
    expect(result.amount).toBe(0)
    expect(result.days).toBe(0)
    expect(result.periods).toEqual([])
    expect(result.fromDate).toBe('2026-06-01')
  })

  it('returns 0 when paid on the due date', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-05-15',
      asOfDate: '2026-05-15',
    })
    expect(result.amount).toBe(0)
    expect(result.days).toBe(0)
  })

  it('counts one day when paid the day after the due date', () => {
    // 36 500 × 0.10 × 1 / 365 = 10.00
    const result = calculateLatePaymentInterest({
      overdueAmount: 36_500,
      dueDate: '2026-05-15',
      asOfDate: '2026-05-16',
    })
    expect(result.days).toBe(1)
    expect(result.amount).toBe(10)
  })

  it('computes the statutory rate for 30 days on 10 000 kr (2026: 2% + 8 pp)', () => {
    // 10 000 × 0.10 × 30 / 365 = 82.1917...
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-15',
    })
    expect(result.days).toBe(30)
    expect(result.rate).toBeCloseTo(0.1, 4)
    expect(result.amount).toBe(82.19)
    expect(result.periods).toEqual([{ from: '2026-04-16', to: '2026-05-15', days: 30, rate: expect.closeTo(0.1, 6) }])
  })

  it('charges each half-year at its own referensränta (Räntelagen 6 §, "vid varje tid")', () => {
    // 2024-12-16..2024-12-31: 16 days at 4% + 8 = 12%; 2025-01-01..2025-02-15: 46 days at 3% + 8 = 11%.
    // 10 000 × (0.12 × 16 + 0.11 × 46) / 365 = 52.6027 + 138.6301 = 191.2329
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2024-12-15',
      asOfDate: '2025-02-15',
    })
    expect(result.days).toBe(62)
    expect(result.periods).toEqual([
      { from: '2024-12-16', to: '2024-12-31', days: 16, rate: expect.closeTo(0.12, 6) },
      { from: '2025-01-01', to: '2025-02-15', days: 46, rate: expect.closeTo(0.11, 6) },
    ])
    expect(result.rate).toBeCloseTo(0.11, 6)
    expect(result.amount).toBe(191.23)
  })

  it('starts a period on the change date when the first interest day is 1 July', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2025-06-30',
      asOfDate: '2025-07-10',
    })
    expect(result.periods).toEqual([{ from: '2025-07-01', to: '2025-07-10', days: 10, rate: expect.closeTo(0.1, 6) }])
  })

  it('applies an override flat across half-year changes', () => {
    // 10 000 × 0.115 × 62 / 365 = 195.3424...
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2024-12-15',
      asOfDate: '2025-02-15',
      overrideRate: 0.115,
    })
    expect(result.periods).toHaveLength(1)
    expect(result.rate).toBe(0.115)
    expect(result.amount).toBe(195.34)
  })

  it('computes with explicit override 5% on 10 000 kr for 30 days', () => {
    // 10 000 × 0.05 × 30 / 365 = 41.0958...
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-15',
      overrideRate: 0.05,
    })
    expect(result.amount).toBe(41.1)
    expect(result.rate).toBe(0.05)
  })

  it('holds an override at referensränta plus 20 points for a consumer (konsumentkreditlagen 4 kap. 4 §)', () => {
    const input = { overdueAmount: 10_000, dueDate: '2026-09-01', asOfDate: '2026-10-01', overrideRate: 0.25 }
    // 2026 referensränta 2%: ceiling 22%. 10 000 × 0.22 × 30 / 365 = 180.82
    const capped = calculateLatePaymentInterest({ ...input, consumer: true })
    expect(capped.amount).toBe(180.82)
    expect(capped.rate).toBe(0.22)
    // A company debtor pays the agreed rate: 10 000 × 0.25 × 30 / 365 = 205.48
    expect(calculateLatePaymentInterest(input).amount).toBe(205.48)
  })

  it('leaves a consumer rate under the ceiling alone', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2026-09-01',
      asOfDate: '2026-10-01',
      overrideRate: 0.12,
      consumer: true,
    })
    // 10 000 × 0.12 × 30 / 365 = 98.63
    expect(result.amount).toBe(98.63)
    expect(result.periods).toHaveLength(1)
  })

  it('moves the consumer ceiling with the referensränta across a half-year', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 10_000,
      dueDate: '2025-06-15',
      asOfDate: '2025-07-15',
      overrideRate: 0.25,
      consumer: true,
    })
    // 15 days at 3% + 20 = 23%, 15 days at 2% + 20 = 22%:
    // 10 000 × (0.23 × 15 + 0.22 × 15) / 365 = 184.93
    expect(result.periods.map((p) => [p.days, p.rate])).toEqual([
      [15, 0.23],
      [15, 0.22],
    ])
    expect(result.amount).toBe(184.93)
  })

  it('throws on a negative overdue amount', () => {
    expect(() =>
      calculateLatePaymentInterest({
        overdueAmount: -500,
        dueDate: '2026-04-15',
        asOfDate: '2026-05-15',
      }),
    ).toThrow()
  })

  it('returns 0 amount when overdueAmount is 0 even if days > 0', () => {
    const result = calculateLatePaymentInterest({
      overdueAmount: 0,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-15',
    })
    expect(result.amount).toBe(0)
    expect(result.days).toBe(0)
  })

  it('rounds to öre', () => {
    // 12 345 × 0.115 × 17 / 365 = 66.1218... → 66.12
    const result = calculateLatePaymentInterest({
      overdueAmount: 12_345,
      dueDate: '2026-04-15',
      asOfDate: '2026-05-02',
      overrideRate: 0.115,
    })
    expect(result.amount).toBe(66.12)
  })

  it('rounds an exact half öre up, which Math.round(x * 100) / 100 gets wrong', () => {
    // 2.01 × 0.5 × 365 / 365 = 1.005, stored as 1.00499999... in binary.
    const result = calculateLatePaymentInterest({
      overdueAmount: 2.01,
      dueDate: '2025-01-01',
      asOfDate: '2026-01-01',
      overrideRate: 0.5,
    })
    expect(result.days).toBe(365)
    expect(result.amount).toBe(1.01)
  })
})
