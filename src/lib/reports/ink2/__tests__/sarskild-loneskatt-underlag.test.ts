import { describe, expect, it } from 'vitest'
import { computeSarskildLoneskattUnderlag } from '../sarskild-loneskatt-underlag'
import type { TrialBalanceRow } from '@/types'

function row(accountNumber: string, balance: number): TrialBalanceRow {
  return {
    account_number: accountNumber,
    account_name: `Konto ${accountNumber}`,
    account_class: Number(accountNumber[0]),
    opening_debit: 0,
    opening_credit: 0,
    period_debit: Math.max(0, balance),
    period_credit: Math.max(0, -balance),
    closing_debit: Math.max(0, balance),
    closing_credit: Math.max(0, -balance),
  }
}

describe('computeSarskildLoneskattUnderlag (INK2 1.4 / 1.5)', () => {
  it('files the pension premiums on 7410-7419 as the underlag, öre dropped', () => {
    const result = computeSarskildLoneskattUnderlag([
      row('7411', 48_000),
      row('7412', 12_000.6),
      row('7533', 14_556.15), // 24,26 % of 60 000,60
    ])
    expect(result.underlag).toBe(60_000)
    expect(result.negativtUnderlag).toBe(0)
    expect(result.warnings).toEqual([])
  })

  it('says so when the särskild löneskatt is not booked', () => {
    const result = computeSarskildLoneskattUnderlag([row('7410', 100_000)])
    expect(result.underlag).toBe(100_000)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('konto 7533 är 0 kr')
    expect(result.warnings[0]).toContain('(100000 kr, punkt 1.4) är 24260 kr')
  })

  it('says so when the tax is booked on a base the declaration does not see', () => {
    const result = computeSarskildLoneskattUnderlag([row('7410', 10_000), row('7533', 5_000)])
    expect(result.warnings[0]).toContain('konto 7533 är 5000 kr')
  })

  it('points at other pension cost accounts that may belong in the underlag', () => {
    const result = computeSarskildLoneskattUnderlag([row('7460', 30_000)])
    expect(result.underlag).toBe(0)
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]).toContain('Konto 7460')
  })

  it('files a negative base on 1.5', () => {
    const result = computeSarskildLoneskattUnderlag([row('7410', -4_000.5)])
    expect(result.underlag).toBe(0)
    expect(result.negativtUnderlag).toBe(4_000)
  })

  it('files nothing and stays quiet without pension costs', () => {
    expect(computeSarskildLoneskattUnderlag([row('7010', 300_000)])).toEqual({
      underlag: 0,
      negativtUnderlag: 0,
      bookedSlp: 0,
      warnings: [],
    })
  })
})
