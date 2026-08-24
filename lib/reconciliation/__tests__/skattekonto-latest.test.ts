import { describe, it, expect } from 'vitest'
import { skattekontoUnexplainedFrom, type SkattekontoReconciliationLatest } from '../skattekonto-latest'

function latest(overrides: Partial<SkattekontoReconciliationLatest> = {}): SkattekontoReconciliationLatest {
  return {
    as_of: '2026-08-20T04:00:00Z',
    computed_at: '2026-08-20T04:00:05Z',
    external_balance: 1000,
    ledger_balance: 900,
    unexplained_difference: 100,
    counts: { proposed: 0, unmatched_external: 1, unmatched_ledger: 0 },
    ...overrides,
  }
}

describe('skattekontoUnexplainedFrom', () => {
  it('returns null without a summary, with an unknown outside balance, or within tolerance', () => {
    expect(skattekontoUnexplainedFrom(null)).toBeNull()
    expect(skattekontoUnexplainedFrom(undefined)).toBeNull()
    expect(skattekontoUnexplainedFrom(latest({ external_balance: null, unexplained_difference: null }))).toBeNull()
    expect(skattekontoUnexplainedFrom(latest({ unexplained_difference: 0 }))).toBeNull()
    expect(skattekontoUnexplainedFrom(latest({ unexplained_difference: -0.5 }))).toBeNull()
  })

  it('returns the signed amount above tolerance and honours a custom tolerance', () => {
    expect(skattekontoUnexplainedFrom(latest({ unexplained_difference: 100 }))).toBe(100)
    expect(skattekontoUnexplainedFrom(latest({ unexplained_difference: -12.5 }))).toBe(-12.5)
    expect(skattekontoUnexplainedFrom(latest({ unexplained_difference: 12.5 }), 50)).toBeNull()
    // A nonsense tolerance falls back to the default (1 SEK).
    expect(skattekontoUnexplainedFrom(latest({ unexplained_difference: 2 }), -5)).toBe(2)
  })
})
