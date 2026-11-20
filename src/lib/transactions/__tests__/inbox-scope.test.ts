import { describe, it, expect } from 'vitest'
import {
  bankRowInSource,
  countInboxScope,
  skattekontoInSource,
  type InboxScopeInput,
} from '@/lib/transactions/inbox-scope'

// The reporter's shape (crm#1056): a handful of pending bank rows across two
// cash accounts plus a larger skattekonto backlog.
const bankRows: InboxScopeInput['bankRows'] = [
  { id: 'b1', date: '2026-09-01', cash_account_id: 'acct-a' },
  { id: 'b2', date: '2026-09-02', cash_account_id: 'acct-a' },
  { id: 'b3', date: '2026-09-03', cash_account_id: 'acct-b' },
  { id: 'b4', date: '2025-12-30', cash_account_id: null },
]
const skattekontoRows: InboxScopeInput['skattekontoRows'] = [
  { id: 's1', transaktionsdatum: '2026-08-12' },
  { id: 's2', transaktionsdatum: '2026-07-12' },
  { id: 's3', transaktionsdatum: '2025-11-12' },
]
const fy2026 = { start: '2026-01-01', end: '2026-12-31' }

function counts(overrides: Partial<InboxScopeInput>) {
  return countInboxScope({ bankRows, skattekontoRows, source: 'all', period: null, ...overrides })
}

describe('bankRowInSource', () => {
  it('takes every bank row under all and bank', () => {
    expect(bankRowInSource('acct-a', 'all')).toBe(true)
    expect(bankRowInSource(null, 'all')).toBe(true)
    expect(bankRowInSource('acct-a', 'bank')).toBe(true)
    expect(bankRowInSource(undefined, 'bank')).toBe(true)
  })

  it('takes only the chosen cash account under acct:<id>', () => {
    expect(bankRowInSource('acct-a', 'acct:acct-a')).toBe(true)
    expect(bankRowInSource('acct-b', 'acct:acct-a')).toBe(false)
    expect(bankRowInSource(null, 'acct:acct-a')).toBe(false)
  })

  it('takes only unassigned rows under bank:other', () => {
    expect(bankRowInSource(null, 'bank:other')).toBe(true)
    expect(bankRowInSource(undefined, 'bank:other')).toBe(true)
    expect(bankRowInSource('acct-a', 'bank:other')).toBe(false)
  })

  it('takes no bank row under skatteverket', () => {
    expect(bankRowInSource('acct-a', 'skatteverket')).toBe(false)
    expect(bankRowInSource(null, 'skatteverket')).toBe(false)
  })
})

describe('skattekontoInSource', () => {
  it('shows skattekonto rows only under all and skatteverket', () => {
    expect(skattekontoInSource('all')).toBe(true)
    expect(skattekontoInSource('skatteverket')).toBe(true)
    expect(skattekontoInSource('bank')).toBe(false)
    expect(skattekontoInSource('bank:other')).toBe(false)
    expect(skattekontoInSource('acct:acct-a')).toBe(false)
  })
})

describe('countInboxScope', () => {
  it('counts bank and skattekonto rows under all sources (the badge includes skattekonto)', () => {
    expect(counts({ source: 'all' })).toEqual({ inScope: 7, hiddenBySource: 0, outsidePeriod: 0 })
  })

  it('counts only the bank rows under bank, and names the skattekonto rows it hides', () => {
    expect(counts({ source: 'bank' })).toEqual({ inScope: 4, hiddenBySource: 3, outsidePeriod: 0 })
  })

  it('counts only one cash account under acct:<id>', () => {
    expect(counts({ source: 'acct:acct-a' })).toEqual({
      inScope: 2,
      hiddenBySource: 5,
      outsidePeriod: 0,
    })
  })

  it('counts only unassigned bank rows under bank:other', () => {
    expect(counts({ source: 'bank:other' })).toEqual({
      inScope: 1,
      hiddenBySource: 6,
      outsidePeriod: 0,
    })
  })

  it('counts only skattekonto rows under skatteverket (crm#1043: no bank row in the badge)', () => {
    expect(counts({ source: 'skatteverket' })).toEqual({
      inScope: 3,
      hiddenBySource: 4,
      outsidePeriod: 0,
    })
  })

  it('reports zero in scope and the whole backlog as hidden when the filter hides everything', () => {
    expect(countInboxScope({ bankRows, skattekontoRows: [], source: 'skatteverket', period: null })).toEqual({
      inScope: 0,
      hiddenBySource: 4,
      outsidePeriod: 0,
    })
    expect(counts({ source: 'acct:closed-account' })).toEqual({
      inScope: 0,
      hiddenBySource: 7,
      outsidePeriod: 0,
    })
  })

  it('puts rows outside the period in their own bucket, whatever their source', () => {
    expect(counts({ source: 'all', period: fy2026 })).toEqual({
      inScope: 5,
      hiddenBySource: 0,
      outsidePeriod: 2,
    })
    // b4 (2025, unassigned) and s3 (2025) are outside the period; inside it,
    // the skattekonto rows s1 and s2 are hidden by the bank source.
    expect(counts({ source: 'bank', period: fy2026 })).toEqual({
      inScope: 3,
      hiddenBySource: 2,
      outsidePeriod: 2,
    })
  })

  it('places every pending row in exactly one bucket', () => {
    for (const source of ['all', 'bank', 'bank:other', 'skatteverket', 'acct:acct-b'] as const) {
      for (const period of [null, fy2026]) {
        const c = counts({ source, period })
        expect(c.inScope + c.hiddenBySource + c.outsidePeriod).toBe(7)
      }
    }
  })

  it('excludes rows on their way out from every count', () => {
    expect(counts({ source: 'all', leaving: new Set(['b1', 's1']) })).toEqual({
      inScope: 5,
      hiddenBySource: 0,
      outsidePeriod: 0,
    })
    expect(counts({ source: 'bank', leaving: new Set(['s1']) })).toEqual({
      inScope: 4,
      hiddenBySource: 2,
      outsidePeriod: 0,
    })
  })

  it('is all zeros for an empty inbox', () => {
    expect(countInboxScope({ bankRows: [], skattekontoRows: [], source: 'all', period: fy2026 })).toEqual({
      inScope: 0,
      hiddenBySource: 0,
      outsidePeriod: 0,
    })
  })
})
